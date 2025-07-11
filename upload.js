const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initializeDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        portal_credentials JSONB NOT NULL,
        images JSONB NOT NULL,
        settings JSONB NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'queued',
        progress VARCHAR(255),
        logs TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database initialized, "jobs" table is ready.');
  } finally {
    client.release();
  }
}

// --- Middleware & File Handling ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const uploadDir = 'images_to_upload';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: storage });

// --- Shared Constants ---
const LOGIN_URL = 'https://wi-charge.c3dss.com/Login';
const USERNAME_SELECTOR = '#username';
const PASSWORD_SELECTOR = '#password';
const LOGIN_BUTTON_SELECTOR = 'button[type="submit"]';
const DROPDOWN_SELECTOR = '#display';
const PREVIEW_AREA_SELECTOR = '#preview1';
const HIDDEN_FILE_INPUT_SELECTOR = '#fileInput1';
const UPLOAD_SUBMIT_BUTTON_SELECTOR = '#pushBtn1';
const STATUS_LOG_SELECTOR = '#statuslog';

// --- Shared puppeteer launch options ---
const puppeteerLaunchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
};

// --- Interactive API Endpoints ---
app.post('/fetch-displays', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });

    console.log('🤖 Fetching displays for user:', username);
    let browser = null;
    try {
        browser = await puppeteer.launch(puppeteerLaunchOptions);
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

app.post('/fetch-display-details', async (req, res) => {
    const { username, password, displayValue } = req.body;
    if (!username || !password || !displayValue) return res.status(400).json({ message: 'Missing required fields.' });

    let browser = null;
    try {
        browser = await puppeteer.launch(puppeteerLaunchOptions);
        const page = await browser.newPage();
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await page.type(USERNAME_SELECTOR, username);
        await page.type(PASSWORD_SELECTOR, password);
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click(LOGIN_BUTTON_SELECTOR)]);
        await page.waitForSelector(DROPDOWN_SELECTOR);
        await page.select(DROPDOWN_SELECTOR, displayValue);
        await new Promise(resolve => setTimeout(resolve, 2000));

        const imageUrl = await page.$eval(PREVIEW_AREA_SELECTOR, el => {
            const style = el.style.backgroundImage;
            const match = style.match(/url\("?(.+?)"?\)/);
            return match ? match[1] : null;
        });

        if (imageUrl) {
            const fullUrl = new URL(imageUrl, LOGIN_URL).href;
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


// --- Job-based API Endpoints ---
app.post('/create-job', upload.array('images'), async (req, res) => {
    const { userId, portalUser, portalPass, interval, cycle, displayValue } = req.body;
    const images = req.files.map(f => ({ path: f.path, originalname: f.originalname }));

    if (!userId || !portalUser || !portalPass || !displayValue || images.length === 0) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `INSERT INTO jobs (user_id, portal_credentials, images, settings, status, progress, logs)
             VALUES ($1, $2, $3, $4, 'queued', 'Job created and waiting to be processed.', NULL) RETURNING id;`,
            [
                userId,
                JSON.stringify({ username: portalUser, password: portalPass }),
                JSON.stringify(images),
                JSON.stringify({ interval, cycle: cycle === 'true', displayValue })
            ]
        );
        const jobId = result.rows[0].id;
        res.status(201).json({ message: 'Automation job created successfully.', jobId });
    } catch (error) {
        console.error("Error creating job:", error);
        res.status(500).json({ message: 'Failed to create job.' });
    } finally {
        client.release();
    }
});

app.get('/job-status/:userId', async (req, res) => {
    const { userId } = req.params;
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT id, status, progress, logs FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'No job found for this user.' });
        }
    } finally {
        client.release();
    }
});

app.post('/stop-job/:jobId', async (req, res) => {
    const { jobId } = req.params;
    if (!jobId) {
        return res.status(400).json({ message: 'Job ID is required.' });
    }
    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE jobs SET status = 'cancelled', progress = 'Job cancelled by user.' WHERE id = $1 AND (status = 'running' OR status = 'queued') RETURNING id`,
            [jobId]
        );
        if (result.rowCount > 0) {
            console.log(`Job ${jobId} has been marked for cancellation.`);
            res.status(200).json({ message: 'Job cancellation request sent successfully.' });
        } else {
            res.status(404).json({ message: 'Job not found or already completed/failed.' });
        }
    } catch (error) {
        console.error(`Error stopping job ${jobId}:`, error);
        res.status(500).json({ message: 'Failed to stop job.' });
    } finally {
        client.release();
    }
});

// --- Worker Logic ---
async function processJob(job) {
    const client = await pool.connect();
    let browser = null;
    try {
        const credentials = job.portal_credentials;
        const settings = job.settings;
        const images = job.images;
        
        await client.query("UPDATE jobs SET progress = 'Logging into portal...' WHERE id = $1", [job.id]);
        
        browser = await puppeteer.launch(puppeteerLaunchOptions);
        const page = await browser.newPage();
        
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await page.type(USERNAME_SELECTOR, credentials.username);
        await page.type(PASSWORD_SELECTOR, credentials.password);
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click(LOGIN_BUTTON_SELECTOR)]);
        
        let isFirstImageOfJob = true;

        do {
          for (let i = 0; i < images.length; i++) {
              const jobCheckResult = await client.query('SELECT status FROM jobs WHERE id = $1', [job.id]);
              if (jobCheckResult.rows[0].status !== 'running') {
                  console.log(`Job ${job.id} status is now '${jobCheckResult.rows[0].status}'. Halting execution.`);
                  return;
              }

              if (!isFirstImageOfJob) {
                  await client.query("UPDATE jobs SET progress = 'Refreshing page for next upload...' WHERE id = $1", [job.id]);
                  await page.reload({ waitUntil: 'networkidle2' });
              }
              isFirstImageOfJob = false;

              await client.query("UPDATE jobs SET progress = 'Selecting display...' WHERE id = $1", [job.id]);
              await page.waitForSelector(DROPDOWN_SELECTOR, { timeout: 30000 });
              await page.select(DROPDOWN_SELECTOR, settings.displayValue);

              const image = images[i];
              const progressMessage = `Uploading image ${i + 1} of ${images.length}: ${image.originalname}`;
              await client.query(`UPDATE jobs SET progress = $1 WHERE id = $2`, [progressMessage, job.id]);
              
              const fileInput = await page.waitForSelector(HIDDEN_FILE_INPUT_SELECTOR, { timeout: 30000 });
              
              const initialLogContent = await page.$eval(STATUS_LOG_SELECTOR, el => el.innerHTML).catch(() => '');

              await fileInput.uploadFile(image.path);
              
              await page.waitForFunction(
                (selector) => {
                  const el = document.querySelector(selector);
                  return el && !el.disabled;
                },
                { timeout: 15000 },
                UPLOAD_SUBMIT_BUTTON_SELECTOR
              );

              let clickSuccessful = false;
              for (let attempt = 0; attempt < 10; attempt++) {
                  try {
                      await page.click(UPLOAD_SUBMIT_BUTTON_SELECTOR);
                      clickSuccessful = true;
                      break;
                  } catch (e) {
                      if (e.message.includes('not clickable')) {
                          console.log(`Attempt ${attempt + 1}: Upload button not clickable, retrying...`);
                          await new Promise(resolve => setTimeout(resolve, 1000));
                      } else {
                          throw e;
                      }
                  }
              }

              if (!clickSuccessful) {
                  throw new Error(`The upload button was enabled but not clickable after 10 retries.`);
              }
              
              await client.query("UPDATE jobs SET progress = 'Waiting for upload confirmation...' WHERE id = $1", [job.id]);
              
              await page.waitForFunction(
                (selector, initialContent) => {
                    const logEl = document.querySelector(selector);
                    return logEl && logEl.innerHTML !== initialContent;
                },
                { timeout: 120000 },
                STATUS_LOG_SELECTOR,
                initialLogContent
              ).catch(e => {
                  throw new Error('Timed out waiting for the status log to update after upload.');
              });

              const logs = await page.$eval(STATUS_LOG_SELECTOR, el => el.innerHTML);
              await client.query("UPDATE jobs SET logs = $1 WHERE id = $2", [logs, job.id]);

              if (logs.toLowerCase().includes('failed') || logs.toLowerCase().includes('error')) {
                  throw new Error('The portal reported an error during the upload. Check the status log for details.');
              }
              
              const waitTime = (parseInt(settings.interval, 10) || 0) * 60 * 1000;
              if (waitTime > 0 && (i < images.length - 1 || settings.cycle)) { 
                await client.query(`UPDATE jobs SET progress = 'Waiting for ${settings.interval} minute(s)...' WHERE id = $1`, [job.id]);
                await new Promise(resolve => setTimeout(resolve, waitTime));
              }
          }
        } while (settings.cycle);

        await client.query("UPDATE jobs SET status = 'completed', progress = 'All images uploaded successfully.' WHERE id = $1", [job.id]);
    } catch (error) {
        console.error(`Error processing job ${job.id}:`, error);
        const errorMessage = error.message.includes('click') || error.message.includes('clickable')
            ? `A button on the page was not clickable. The website layout may have changed or an overlay was present. (Selector: ${UPLOAD_SUBMIT_BUTTON_SELECTOR})`
            : error.message;
        await client.query("UPDATE jobs SET status = 'failed', progress = $2 WHERE id = $1", [job.id, `An error occurred: ${errorMessage}`]);
    } finally {
        if (browser) await browser.close();
        job.images.forEach(img => fs.unlink(img.path, (err) => {
            if(err) console.error("Error deleting file:", img.path, err);
        }));
        client.release();
    }
}

async function checkAndProcessJobs() {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE jobs
            SET status = 'running', progress = 'Starting job processing...'
            WHERE id = (
                SELECT id
                FROM jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *;
        `;
        const { rows } = await client.query(query);

        if (rows.length > 0) {
            const job = rows[0];
            console.log(`Picked up job ${job.id} to process.`);
            processJob(job).catch(err => {
                console.error(`Unhandled exception in processJob for job ${job.id}:`, err);
            });
        }
    } catch (error) {
        console.error("Error in job checker:", error);
    } finally {
        client.release();
    }
}

// Start the server after DB initialization
initializeDb().then(() => {
    setInterval(checkAndProcessJobs, 5000);
    app.listen(port, () => {
        console.log(`🚀 Stateful automation server listening on port ${port}`);
    });
}).catch(e => console.error("Failed to initialize database:", e));
