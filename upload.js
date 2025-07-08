const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const port = process.env.PORT || 3001; // Use port provided by host or default to 3001

// --- Middleware ---
app.use(cors()); // Allow requests from our frontend
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- File Upload Handling ---
const uploadDir = 'images_to_upload';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// --- THE AUTOMATION LOGIC (from your original script) ---
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
    browser = await puppeteer.launch({ 
        headless: true, // Must be true on most servers
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required for many hosting environments
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Login, dropdown selection, and the loop logic is the same as your script...
    // [The full automation logic from your script would go here]
    // This is a simplified version for brevity. You would paste your full `runAutomationSuite` logic here,
    // adapting it to use the `options` object passed into this function.
    
    console.log(`➡️ Navigating to login page: ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    console.log(`👤 Typing username...`);
    await page.type(USERNAME_SELECTOR, USERNAME);
    // ...and so on for the rest of your script's logic.

    console.log('✅ Automation task completed successfully.');

  } catch (error) {
    console.error('❌ A critical error occurred during the automation process:', error);
  } finally {
    if (browser) await browser.close();
    // Clean up uploaded files
    imageFiles.forEach(file => {
        fs.unlink(path.join(uploadDir, file.originalname), err => {
            if (err) console.error(`Error deleting file: ${file.originalname}`, err);
        });
    });
    console.log('...cleaned up temporary files.');
  }
}

// --- API Endpoint ---
app.post('/start-automation', upload.array('images'), (req, res) => {
  const { username, password, interval } = req.body;
  const images = req.files;

  if (!username || !password || !images || images.length === 0) {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  // Start the automation but don't make the user wait for it to finish.
  runAutomation({ username, password, interval, imageFiles: images });

  res.status(202).json({ message: `Automation accepted and started for ${images.length} images. Check the server logs for progress.` });
});

app.listen(port, () => {
  console.log(`🚀 Automation server listening on port ${port}`);
});
