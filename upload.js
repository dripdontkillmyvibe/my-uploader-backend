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

    // --- API Endpoints ---
    app.post('/create-job', upload.array('images'), async (req, res) => {
        const { userId, portalUser, portalPass, interval, cycle, displayValue } = req.body;
        const images = req.files.map(f => ({ path: f.path, originalname: f.originalname }));

        if (!userId || !portalUser || !portalPass || !displayValue || images.length === 0) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        const client = await pool.connect();
        try {
            await client.query(
                `INSERT INTO jobs (user_id, portal_credentials, images, settings, status, progress)
                 VALUES ($1, $2, $3, $4, 'queued', 'Job created and waiting to be processed.')`,
                [
                    userId,
                    JSON.stringify({ username: portalUser, password: portalPass }),
                    JSON.stringify(images),
                    JSON.stringify({ interval, cycle: cycle === 'true', displayValue })
                ]
            );
            res.status(201).json({ message: 'Automation job created successfully.' });
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

    // --- Worker Logic ---
    async function processJob(job) {
        const client = await pool.connect();
        let browser = null;
        try {
            await client.query(`UPDATE jobs SET status = 'running', progress = 'Launching browser...' WHERE id = $1`, [job.id]);
            
            browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            
            const credentials = job.portal_credentials;
            const settings = job.settings;
            const images = job.images;

            // ... [The Puppeteer automation logic goes here, adapted to use the job data]
            // It will need to update the database with progress using client.query()
            // For example:
            await client.query(`UPDATE jobs SET progress = 'Logging into portal...' WHERE id = $1`, [job.id]);
            await page.goto('https://wi-charge.c3dss.com/Login');
            // ... etc.

            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                await client.query(`UPDATE jobs SET progress = 'Uploading image ${i + 1} of ${images.length}: ${image.originalname}' WHERE id = $1`, [job.id]);
                // ... puppeteer logic to upload image.path ...
            }

            await client.query(`UPDATE jobs SET status = 'completed', progress = 'All images uploaded successfully.' WHERE id = $1`, [job.id]);
        } catch (error) {
            console.error(`Error processing job ${job.id}:`, error);
            await client.query(`UPDATE jobs SET status = 'failed', progress = 'An error occurred: ${error.message}' WHERE id = $1`, [job.id]);
        } finally {
            if (browser) await browser.close();
            // Clean up uploaded files
            job.images.forEach(img => fs.unlink(img.path, (err) => {
                if(err) console.error("Error deleting file:", img.path, err);
            }));
            client.release();
        }
    }

    async function checkJobs() {
        const client = await pool.connect();
        try {
            const result = await client.query(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`);
            if (result.rows.length > 0) {
                const job = result.rows[0];
                console.log(`Found job ${job.id} to process.`);
                await processJob(job);
            }
        } finally {
            client.release();
        }
    }

    // Start the server after DB initialization
    initializeDb().then(() => {
        // Check for new jobs every 30 seconds
        setInterval(checkJobs, 30000); 
        app.listen(port, () => {
            console.log(`🚀 Stateful automation server listening on port ${port}`);
        });
    }).catch(e => console.error("Failed to initialize database:", e));
    
