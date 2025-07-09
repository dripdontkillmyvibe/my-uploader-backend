const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // This is the important part.
  // It tells Puppeteer to download the browser to a local, predictable folder.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
