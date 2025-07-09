const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const port = process.env.PORT || 3001;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- File Upload Handling ---
const uploadDir = 'images_to_upload';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage: storage });

// --- Shared Automation Constants ---
const LOGIN_URL = 'https://wi-charge.c3dss.com/Login';
const USERNAME_SELECTOR = '#username';
const PASSWORD_SELECTOR = '#password';
const LOGIN_BUTTON_SELECTOR = 'button[type="submit"]';
const DROPDOWN_SELECTOR = '#display';
const HIDDEN_FILE_INPUT_SELECTOR = '#fileInput1';
const UPLOAD_SUBMIT_BUTTON_SELECTOR = '#pushBtn1';

// --- NEW ENDPOINT: To fetch display options ---
app.post('/fetch-displays', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  console.log('🤖 Fetching displays for user:', username);
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await page.type(USERNAME_SELECTOR, username);
    await page.type(PASSWORD_SELECTOR, password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click(LOGIN_BUTTON_SELECTOR),
    ]);
    console.log('...login successful, finding dropdown.');
    await page.waitForSelector(DROPDOWN_SELECTOR);
    const options = await page.$$eval(`${DROPDOWN_SELECTOR} option`, opts =>
      opts
        .map(o => ({ value: o.value, text: o.innerText }))
        .filter(o => o.value && o.value !== "0") // Filter out the placeholder "--Select Display--"
    );
    console.log(`...found ${options.length} displays.`);
    res.json(options);
  } catch (error) {
    console.error('❌ Error fetching displays:', error);
    res.status(500).json({ message: 'Failed to fetch displays. Please check credentials.' });
  } finally {
    if (browser) await browser.close();
  }
});


// --- UPDATED ENDPOINT: To run the full automation ---
app.post('/start-automation', upload.array('images'), (req, res) => {
  const { username, password, interval, displayValue } = req.body; // Now accepts displayValue
  const images = req.files;

  if (!username || !password || !images || images.length === 0 || !displayValue) {
    return res.status(400).json({ message: 'Missing required fields, including a selected display.' });
  }

  // Start automation in the background
  runAutomation({ username, password, interval, displayValue, imageFiles: images });

  res.status(202).json({ message: `Automation accepted for display "${displayValue}". Check server logs for progress.` });
});


async function runAutomation(options) {
  const { username, password, interval, displayValue, imageFiles } = options;
  console.log('🤖 Full automation task received for display:', displayValue);
  
  const TIME_INTERVAL_SECONDS = parseInt(interval, 10);
  const ACTION_DELAY_SECONDS = 5;

  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await page.type(USERNAME_SELECTOR, username);
    await page.type(PASSWORD_SELECTOR, password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click(LOGIN_BUTTON_SELECTOR),
    ]);
    console.log('✅ Login Successful!');

    console.log(`...selecting user-chosen display: ${displayValue}`);
    await page.waitForSelector(DROPDOWN_SELECTOR);
    await page.select(DROPDOWN_SELECTOR, displayValue); // Use the provided display value
    console.log('✅ Display selected.');
    await new Promise(resolve => setTimeout(resolve, ACTION_DELAY_SECONDS * 1000));

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const imagePath = path.join(uploadDir, file.filename);
      console.log(`---`);
      console.log(`[${i + 1}/${imageFiles.length}] Processing: ${file.filename}`);
      
      const fileInput = await page.waitForSelector(HIDDEN_FILE_INPUT_SELECTOR);
      await fileInput.uploadFile(imagePath);
      console.log(`...selected ${file.filename} for upload.`);
      await new Promise(resolve => setTimeout(resolve, ACTION_DELAY_SECONDS * 1000));
      
      if (UPLOAD_SUBMIT_BUTTON_SELECTOR) {
          await page.waitForSelector(UPLOAD_SUBMIT_BUTTON_SELECTOR, { visible: true });
          await page.click(UPLOAD_SUBMIT_BUTTON_SELECTOR);
          console.log('...clicked submit button.');
      }

      console.log(`🎉 Successfully submitted ${file.filename}!`);
      if (i < imageFiles.length - 1) {
        console.log(`...waiting for ${TIME_INTERVAL_SECONDS}s...`);
        await new Promise(resolve => setTimeout(resolve, TIME_INTERVAL_SECONDS * 1000));
      }
    }
  } catch (error) {
    console.error('❌ A critical error occurred during the automation process:', error);
  } finally {
    if (browser) await browser.close();
    imageFiles.forEach(file => {
        fs.unlink(path.join(uploadDir, file.filename), err => {
            if (err) console.error(`Error deleting file: ${file.filename}`, err);
        });
    });
    console.log('...automation task finished and cleaned up temporary files.');
  }
}

app.listen(port, () => {
  console.log(`🚀 Automation server listening on port ${port}`);
});
