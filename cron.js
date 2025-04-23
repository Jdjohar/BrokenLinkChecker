if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const cron = require('cron');
const https = require('https');
const { analyzeWebsites } = require('./broken-link-checker');

// Server restart configuration
const backendUrl = process.env.BACKEND_URL || 'https://brokenlink.onrender.com';

// Validate environment variables
if (!process.env.EMAIL_FROM || !process.env.EMAIL_TO || !process.env.EMAIL_PASSWORD) {
  console.error('Missing required environment variables: EMAIL_FROM, EMAIL_TO, or EMAIL_PASSWORD');
  process.exit(1);
}

// Cron job for server restart (every 14 minutes, IST)
const restartJob = new cron.CronJob('*/14 * * * *', function () {
  console.log('Restarting server');
  https.get(backendUrl, (res) => {
    if (res.statusCode === 200) {
      console.log('Server restarted');
    } else {
      console.error(`Failed to restart server with status code: ${res.statusCode}`);
    }
  }).on('error', (err) => {
    console.error('Error during Restart:', err.message);
  });
}, null, true, 'Asia/Kolkata');

// Cron job for daily website scan (11:40 AM IST)
const scanJob = new cron.CronJob('40 11 * * *', async function () {
  console.log('Starting daily website scan');
  try {
    await analyzeWebsites();
    console.log('Daily website scan completed');
  } catch (error) {
    console.error('Error during daily scan:', error.message);
  }
}, null, true, 'Asia/Kolkata');

// Start both cron jobs
restartJob.start();
scanJob.start();

// Export the cron jobs
module.exports = {
  restartJob,
  scanJob,
};
