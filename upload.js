const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const port = process.env.PORT || 3001;

// --- Server & Middleware Setup ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
const STATUS_LOG_SELECTOR = '#statuslog';
const PREVIEW_AREA_SELECTOR = '#preview1';

// --- HTTP Endpoints ---

// Endpoint to fetch initial display options
app.post('/fetch-displays', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
    console.log('🤖 Fetching displays for user:', username);
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await page.type(USERNAME_SELECTOR, username);
        await page.type(PASSWORD_SELECTOR, password);
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click(LOGIN_BUTTON_SELECTOR)]);
        await page.waitForSelector(DROPDOWN_SELECTOR);
        const options = await page.$$eval(`${DROPDOWN_SELECTOR} option`, opts => opts.map(o => ({ value: o.value, text: o.innerText })).filter(o => o.value && o.value !== "0"));
        res.json(options);
    } catch (error) {
        console.error('❌ Error fetching displays:', error);
        res.status(500).json({ message: 'Failed to fetch displays. Please check credentials.' });
    } finally {
        if (browser) await browser.close();
    }
});

// NEW Endpoint to fetch details (like current image) for a specific display
app.post('/fetch-display-details', async (req, res) => {
    const { username, password, displayValue } = req.body;
    if (!username || !password || !displayValue) return res.status(400).json({ message: 'Missing required fields.' });

    console.log('🤖 Fetching details for display:', displayValue);
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await page.type(USERNAME_SELECTOR, username);
        await page.type(PASSWORD_SELECTOR, password);
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click(LOGIN_BUTTON_SELECTOR)]);
        await page.waitForSelector(DROPDOWN_SELECTOR);
        await page.select(DROPDOWN_SELECTOR, displayValue);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for potential AJAX update

        const imageUrl = await page.$eval(PREVIEW_AREA_SELECTOR, el => {
            const style = el.style.backgroundImage;
            const match = style.match(/url\("?(.+?)"?\)/);
            return match ? match[1] : null;
        });

        if (imageUrl) {
            const fullUrl = new URL(imageUrl, LOGIN_URL).href;
            console.log('...found image URL:', fullUrl);
            res.json({ imageUrl: fullUrl });
        } else {
            res.json({ imageUrl: null });
        }
    } catch (error) {
        console.error('❌ Error fetching display details:', error);
        res.status(500).json({ message: 'Failed to fetch display details.' });
    } finally {
        if (browser) await browser.close();
    }
});

// --- WebSocket Logic for Live Automation ---
wss.on('connection', ws => {
    console.log('🔗 Client connected via WebSocket');
    ws.on('message', async message => {
        const data = JSON.parse(message);
        if (data.type === 'start-automation') {
            runAutomation(data.payload, ws).catch(err => {
                console.error("Automation run failed:", err);
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
            });
        }
    });
    ws.on('close', () => console.log('👋 Client disconnected'));
});


async function runAutomation(options, ws) {
    const { username, password, interval, displayValue, cycle, imageFiles } = options;
    ws.send(JSON.stringify({ type: 'log', message: `🤖 Automation task received for display: ${displayValue}. Cycle mode: ${cycle}` }));
    
    const TIME_INTERVAL_SECONDS = parseInt(interval, 10);
    const ACTION_DELAY_SECONDS = 5;

    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        await page.exposeFunction('onLogUpdate', (logText) => {
            ws.send(JSON.stringify({ type: 'portal-log', message: logText }));
        });

        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await page.type(USERNAME_SELECTOR, username);
        await page.type(PASSWORD_SELECTOR, password);
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click(LOGIN_BUTTON_SELECTOR)]);
        ws.send(JSON.stringify({ type: 'log', message: '✅ Login Successful!' }));

        await page.waitForSelector(DROPDOWN_SELECTOR);
        await page.select(DROPDOWN_SELECTOR, displayValue);
        ws.send(JSON.stringify({ type: 'log', message: `✅ Display "${displayValue}" selected.` }));
        await new Promise(resolve => setTimeout(resolve, ACTION_DELAY_SECONDS * 1000));

        await page.evaluate((selector) => {
            const targetNode = document.querySelector(selector);
            if (targetNode) {
                const observer = new MutationObserver(mutationsList => {
                    for(const mutation of mutationsList) {
                        if (mutation.type === 'childList' || mutation.type === 'characterData') {
                           window.onLogUpdate(targetNode.innerText);
                        }
                    }
                });
                observer.observe(targetNode, { childList: true, subtree: true, characterData: true });
            }
        }, STATUS_LOG_SELECTOR);

        do {
            for (let i = 0; i < imageFiles.length; i++) {
                const file = imageFiles[i];
                const imagePath = path.join(uploadDir, file.filename);
                ws.send(JSON.stringify({ type: 'log', message: `--- [${i+1}/${imageFiles.length}] Processing: ${file.filename} ---` }));
                
                const fileInput = await page.waitForSelector(HIDDEN_FILE_INPUT_SELECTOR);
                await fileInput.uploadFile(imagePath);
                
                if (UPLOAD_SUBMIT_BUTTON_SELECTOR) {
                    await page.waitForSelector(UPLOAD_SUBMIT_BUTTON_SELECTOR, { visible: true });
                    await page.click(UPLOAD_SUBMIT_BUTTON_SELECTOR);
                }
                
                await page.waitForFunction(
                    (selector, successText) => document.querySelector(selector)?.innerText.includes(successText),
                    { timeout: 60000 },
                    STATUS_LOG_SELECTOR,
                    'File uploaded successfully'
                );
                ws.send(JSON.stringify({ type: 'log', message: `🎉 Successfully submitted ${file.filename}!` }));

                // NEW: Fetch and send the updated image URL
                try {
                    const newImageUrl = await page.$eval(PREVIEW_AREA_SELECTOR, el => {
                        const style = el.style.backgroundImage;
                        const match = style.match(/url\("?(.+?)"?\)/);
                        return match ? match[1] : null;
                    });
                    if (newImageUrl) {
                        const fullUrl = new URL(newImageUrl, LOGIN_URL).href;
                        ws.send(JSON.stringify({ type: 'image-update', imageUrl: fullUrl }));
                    }
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'log', message: 'Could not retrieve updated image thumbnail.' }));
                }

                if (cycle || i < imageFiles.length - 1) {
                    ws.send(JSON.stringify({ type: 'log', message: `...waiting for ${TIME_INTERVAL_SECONDS}s...` }));
                    await new Promise(resolve => setTimeout(resolve, TIME_INTERVAL_SECONDS * 1000));
                }
            }
            if(cycle) ws.send(JSON.stringify({ type: 'log', message: '...cycling back to the first image.' }));
        } while (cycle);
        
        ws.send(JSON.stringify({ type: 'done', message: 'All tasks completed successfully.' }));

    } catch (error) {
        console.error('❌ A critical error occurred during the automation process:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message || 'An unknown error occurred.' }));
    } finally {
        if (browser) await browser.close();
        imageFiles.forEach(file => {
            fs.unlink(path.join(uploadDir, file.filename), err => {
                if (err) console.error(`Error deleting file: ${file.filename}`, err);
            });
        });
        console.log('...automation task finished and cleaned up temporary files.');
        ws.close();
    }
}

// Separate endpoint to handle the initial file uploads
app.post('/upload-files', upload.array('images'), (req, res) => {
    console.log(`...received ${req.files.length} files for staging.`);
    const uploadedFiles = req.files.map(f => ({ filename: f.filename, originalname: f.originalname }));
    res.status(200).json({ message: 'Files staged successfully', files: uploadedFiles });
});

// Use the http server to listen, not the express app
server.listen(port, () => {
  console.log(`🚀 Automation server with WebSocket listening on port ${port}`);
});
