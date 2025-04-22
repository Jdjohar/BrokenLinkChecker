const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const url = require('url');
const { XMLParser } = require('fast-xml-parser');

// Configuration
const WEBSITES = [
  'https://innovapte.com',
  'https://datavapte.com',
  'https://innovtrack.com',
];
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const CONCURRENT_REQUESTS = 10; // Reduced for API delay handling
const REQUEST_DELAY = 200; // Increased for API delay handling
const MAX_URLS_PER_SITE = 500; // Max URLs to check per site

// Function to check if a URL is valid
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// Function to resolve relative URLs
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (error) {
    console.error(`Error resolving URL: ${relative}`);
    return null;
  }
}

// Function to check if a link is within the same domain
function isSameDomain(baseUrl, linkUrl) {
  try {
    const base = new URL(baseUrl);
    const link = new URL(linkUrl);
    return base.hostname === link.hostname;
  } catch (error) {
    return false;
  }
}

// Function to add a delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to check a single link
async function checkLink(linkUrl, sourceUrl, brokenLinks, checkedUrls) {
  if (checkedUrls.has(linkUrl) || !isValidUrl(linkUrl)) {
    if (!isValidUrl(linkUrl)) {
      brokenLinks.push({ url: linkUrl, status: 'Invalid URL', source: sourceUrl });
    }
    return;
  }
  checkedUrls.add(linkUrl);

  try {
    const response = await axios.get(linkUrl, { timeout: 5000 });
    if (response.status < 200 || response.status >= 400) {
      brokenLinks.push({ url: linkUrl, status: response.status, source: sourceUrl });
    }
  } catch (error) {
    const status = error.response ? error.response.status : 'Unreachable';
    brokenLinks.push({ url: linkUrl, status, source: sourceUrl });
  }
}

// Function to fetch URLs from sitemap
async function fetchSitemap(sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl, { timeout: 5000 });
    const parser = new XMLParser();
    const parsed = parser.parse(response.data);

    const urls = [];
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
      const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
        ? parsed.sitemapindex.sitemap
        : [parsed.sitemapindex.sitemap];
      for (const sitemap of sitemaps) {
        if (sitemap.loc) {
          const subSitemapUrls = await fetchSitemap(sitemap.loc);
          urls.push(...subSitemapUrls);
        }
      }
    }
    if (parsed.urlset && parsed.urlset.url) {
      const sitemapUrls = Array.isArray(parsed.urlset.url)
        ? parsed.urlset.url
        : [parsed.urlset.url];
      urls.push(...sitemapUrls.map(u => u.loc).filter(u => isValidUrl(u)));
    }
    return urls.slice(0, MAX_URLS_PER_SITE);
  } catch (error) {
    console.error(`Error fetching sitemap ${sitemapUrl}: ${error.message}`);
    return [];
  }
}

// Function to get URLs from homepage as fallback
async function fetchHomepageLinks(baseUrl) {
  try {
    const response = await axios.get(baseUrl, { timeout: 5000 });
    const $ = cheerio.load(response.data);
    const links = [];
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        const resolvedUrl = resolveUrl(baseUrl, href);
        if (resolvedUrl && isSameDomain(baseUrl, resolvedUrl)) {
          links.push(resolvedUrl);
        }
      }
    });
    return [...new Set(links)].slice(0, MAX_URLS_PER_SITE);
  } catch (error) {
    console.error(`Error fetching homepage ${baseUrl}: ${error.message}`);
    return [];
  }
}

// Function to extract internal links from a page
async function extractInternalLinks(pageUrl, websiteUrl, checkedUrls) {
  try {
    const response = await axios.get(pageUrl, { timeout: 5000 });
    const $ = cheerio.load(response.data);
    const links = [];
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        const resolvedUrl = resolveUrl(pageUrl, href);
        if (resolvedUrl && isSameDomain(websiteUrl, resolvedUrl) && !checkedUrls.has(resolvedUrl)) {
          links.push(resolvedUrl);
        }
      }
    });
    return [...new Set(links)];
  } catch (error) {
    console.error(`Error extracting links from ${pageUrl}: ${error.message}`);
    return [];
  }
}

// Function to collect all links for a website
async function collectLinks(websiteUrl) {
  const sitemapUrls = [
    `${websiteUrl}/sitemap.xml`,
    `${websiteUrl}/sitemap_index.xml`,
  ];

  let initialUrls = [];
  for (const sitemapUrl of sitemapUrls) {
    const sitemapLinks = await fetchSitemap(sitemapUrl);
    if (sitemapLinks.length > 0) {
      initialUrls = [...new Set(sitemapLinks)];
      console.log(`Found ${initialUrls.length} URLs in sitemap for ${websiteUrl}`);
      break;
    }
  }

  if (initialUrls.length === 0) {
    console.log(`No sitemap found for ${websiteUrl}, crawling homepage...`);
    initialUrls = await fetchHomepageLinks(websiteUrl);
    console.log(`Found ${initialUrls.length} URLs on homepage for ${websiteUrl}`);
  }

  const urlsToCheck = [];
  const checkedUrls = new Set();
  for (const url of initialUrls) {
    if (urlsToCheck.length >= MAX_URLS_PER_SITE) break;
    urlsToCheck.push(url);
    checkedUrls.add(url);
    const internalLinks = await extractInternalLinks(url, websiteUrl, checkedUrls);
    urlsToCheck.push(...internalLinks);
  }

  return [...new Set(urlsToCheck)].slice(0, MAX_URLS_PER_SITE);
}

// Function to check all links for a website
async function checkAllLinks(urlsToCheck, websiteUrl, brokenLinks, checkedUrls) {
  console.log(`Checking ${urlsToCheck.length} URLs for ${websiteUrl}...`);
  for (let i = 0; i < urlsToCheck.length; i += CONCURRENT_REQUESTS) {
    const batch = urlsToCheck.slice(i, i + CONCURRENT_REQUESTS);
    await Promise.all(
      batch.map(async (link, index) => {
        await checkLink(link, 'Sitemap or Inner Page', brokenLinks, checkedUrls);
        await delay(REQUEST_DELAY);
        const progress = Math.round(((i + index + 1) / urlsToCheck.length) * 100);
        console.log(`Progress for ${websiteUrl}: ${progress}% (${i + index + 1}/${urlsToCheck.length})`);
      })
    );
  }
}

// Function to generate the HTML email report for a website
function generateReport(websiteUrl, brokenLinks, checkedUrls) {
  const formattedDate = new Date().toLocaleString();
  const totalBrokenLinks = brokenLinks.length;
  const totalUrlsChecked = checkedUrls.size;

  // HTML email template
  const htmlReport = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: Arial, sans-serif; color: #333; background-color: #f4f4f4; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .header { background: #004aad; color: #fff; padding: 20px; text-align: center; border-top-left-radius: 8px; border-top-right-radius: 8px; }
        .header h1 { margin: 0; font-size: 24px; }
        .content { padding: 20px; }
        h2 { color: #004aad; font-size: 20px; margin-top: 0; }
        p { line-height: 1.6; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
        th { background: #f9f9f9; font-weight: bold; }
        .footer { text-align: center; padding: 20px; border-top: 1px solid #ddd; font-size: 14px; color: #777; }
        .footer a { color: #004aad; text-decoration: none; }
        @media (max-width: 600px) { .container { padding: 10px; } table { font-size: 14px; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Broken Links Report for ${websiteUrl}</h1>
        </div>
        <div class="content">
          <h2>Summary</h2>
          <p><strong>Website:</strong> <a href="${websiteUrl}">${websiteUrl}</a></p>
          <p><strong>Date:</strong> ${formattedDate}</p>
          <p><strong>Total URLs Checked:</strong> ${totalUrlsChecked}</p>
          <p><strong>Total Broken Links Found:</strong> ${totalBrokenLinks}</p>

          <h2>Broken Links</h2>
          ${
            totalBrokenLinks === 0
              ? '<p>No broken links were found.</p>'
              : `
                <table>
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th>Status</th>
                      <th>Source Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${brokenLinks
                      .map(
                        link => `
                          <tr>
                            <td><a href="${link.url}">${link.url}</a></td>
                            <td>${link.status}</td>
                            <td><a href="${link.source}">${link.source}</a></td>
                          </tr>
                        `
                      )
                      .join('')}
                  </tbody>
                </table>
              `
          }

          <h2>Scanned URLs</h2>
          ${
            checkedUrls.size === 0
              ? '<p>No URLs were scanned.</p>'
              : `
                <p>The following ${checkedUrls.size} URLs were checked:</p>
                <ul>
                  ${Array.from(checkedUrls)
                    .map(url => `<li><a href="${url}">${url}</a></li>`)
                    .join('')}
                </ul>
              `
          }
        </div>
        <div class="footer">
          <p>Generated by Website Link Checker | <a href="https://datavapte.com">Visit Datavapte</a></p>
          <p>Contact us at <a href="mailto:support@datavapte.com">support@datavapte.com</a></p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Plain text fallback
  const textReport = `
Broken Links Report for ${websiteUrl}

Website: ${websiteUrl}
Date: ${formattedDate}
Total URLs Checked: ${totalUrlsChecked}
Total Broken Links Found: ${totalBrokenLinks}

Broken Links:
${
  totalBrokenLinks === 0
    ? 'No broken links found.'
    : brokenLinks
        .map(link => `URL: ${link.url}\nStatus: ${link.status}\nSource: ${link.source}\n`)
        .join('\n')
}

Scanned URLs:
${checkedUrls.size === 0 ? 'No URLs were scanned.' : Array.from(checkedUrls).join('\n')}
`;

  return { html: htmlReport, text: textReport };
}

// Function to send the report via email
async function sendEmail(report, websiteUrl) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_FROM,
      pass: EMAIL_PASSWORD,
    },
  });

  const mailOptions = {
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `Broken Links Report for ${websiteUrl}`,
    text: report.text,
    html: report.html,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent successfully for ${websiteUrl}`);
  } catch (error) {
    console.error(`Error sending email for ${websiteUrl}: ${error.message}`);
  }
}

// Function to analyze a single website
async function analyzeWebsite(websiteUrl) {
  console.log(`Starting broken link check for ${websiteUrl}`);
  const brokenLinks = [];
  const checkedUrls = new Set();
  const urlsToCheck = await collectLinks(websiteUrl);
  await checkAllLinks(urlsToCheck, websiteUrl, brokenLinks, checkedUrls);

  const report = generateReport(websiteUrl, brokenLinks, checkedUrls);
  console.log(report.text); // Log plain text version to console
  await sendEmail(report, websiteUrl);
}

// Main function to analyze all websites
async function main() {
  for (const websiteUrl of WEBSITES) {
    await analyzeWebsite(websiteUrl);
  }
  console.log('All websites analyzed and reports sent.');
}

// Export the main function for cron job
module.exports = { analyzeWebsites: main };

// Run the program if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error(`Program error: ${error.message}`);
  });
}
