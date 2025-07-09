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

// --- THE AUTOMATION LOGIC ---
async function runAutomation(options) {
  const { username, password, interval, imageFiles } = options;
  console.log('🤖 Automation task received:', { username, interval, imageCount: imageFiles.length });

  // --- Main Configuration ---
  const LOGIN_URL = 'https://wi-charge.c3dss.com/Login';
  const USERNAME = username;
  const PASSWORD = password;
  const TIME_INTERVAL_SECONDS = parseInt(interval, 10);
  const ACTION_DELAY_SECONDS = 5;
  const USERNAME_SELECTOR = '#username';
  const PASSWORD_SELECTOR = '#password';
  const LOGIN_BUTTON_SELECTOR = 'button[type="submit"]';
  const DROPDOWN_SELECTOR = '#display';
  const HIDDEN_FILE_INPUT_SELECTOR = '#fileInput1';
  const UPLOAD_SUBMIT_BUTTON_SELECTOR = '#pushBtn1';

  let browser = null;
  try {
    console.log('...launching browser with server settings.');
    browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Common fix for server environments
            '--single-process'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`➡️ Navigating to login page: ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    console.log(`👤 Typing username...`);
    await page.type(USERNAME_SELECTOR, USERNAME, { delay: 100 });
    await new Promise(resolve => setTimeout(resolve, ACTION_DELAY_SECONDS * 1000));

    console.log('🔑 Typing password...');
    await page.type(PASSWORD_SELECTOR, PASSWORD, { delay: 100 });
    await new Promise(resolve => setTimeout(resolve, ACTION_DELAY_SECONDS * 1000));
    
    console.log('🚀 Clicking login button...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(LOGIN_BUTTON_SELECTOR),
    ]);
    console.log('✅ Login Successful!');

    if (DROPDOWN_SELECTOR) {
        console.log(`...handling dropdown selection.`);
        await page.waitForSelector(DROPDOWN_SELECTOR);
        const dropdownOptions = await page.$$eval(`${DROPDOWN_SELECTOR} option`, opts => opts.map(o => ({ value: o.value, text: o.innerText })));
        if (dropdownOptions.length > 1) {
            await page.select(DROPDOWN_SELECTOR, dropdownOptions[1].value);
            console.log(`✅ Selected option: "${dropdownOptions[1].text}"`);
        }
        await new Promise(resolve => setTimeout(resolve, ACTION_DELAY_SECONDS * 1000));
    }

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

// --- API Endpoint ---
app.post('/start-automation', upload.array('images'), (req, res) => {
  const { username, password, interval } = req.body;
  const images = req.files;

  if (!username || !password || !images || images.length === 0) {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  runAutomation({ username, password, interval, imageFiles: images });

  res.status(202).json({ message: `Automation accepted and started for ${images.length} images. Check the server logs on Render for progress.` });
});

app.listen(port, () => {
  console.log(`🚀 Automation server listening on port ${port}`);
});
