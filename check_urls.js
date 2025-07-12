// 引入所需的库
const { Client } = require("@notionhq/client");
const playwright = require("playwright");
// [FIXED] 修正 p-limit 的导入方式以兼容 CommonJS
const { default: pLimit } = require("p-limit");

// 从 GitHub Secrets 获取 Notion API 密钥和数据库 ID
const notionApiKey = process.env.NOTION_API_KEY;
const databaseId = process.env.NOTION_DATABASE_ID;

// 初始化 Notion 客户端
const notion = new Client({ auth: notionApiKey });

// --- [OPTIMIZATION] ---
// 设置并发限制，5 是一个在 GitHub Actions 环境中稳定运行的推荐值
const limit = pLimit(5);

// 状态映射
const STATUS_MAP = {
  available: "可用",
  redirect: "重定向",
  dead: "已失效",
  error: "错误",
};

/**
 * 使用 Playwright 检查单个 URL 的有效性
 * @param {import('playwright').Browser} browser - Playwright 浏览器实例
 * @param {string} url - 需要检查的 URL
 * @returns {Promise<string>} - 返回链接的状态
 */
async function checkUrlStatus(browser, url) {
  if (!url) {
    return STATUS_MAP.error;
  }
  let page;
  try {
    page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const finalUrl = page.url();
    const status = response.status();

    if (finalUrl !== url && finalUrl !== url + '/') {
      return STATUS_MAP.redirect;
    }
    if (status >= 200 && status < 400) {
      return STATUS_MAP.available;
    } else if (status === 404) {
      return STATUS_MAP.dead;
    } else {
      return STATUS_MAP.error;
    }
  } catch (error) {
    console.error(`🔴 检查 "${url}" 时发生 Playwright 错误: ${error.message}`);
    if (error.message.includes('404')) {
      return STATUS_MAP.dead;
    }
    return STATUS_MAP.error;
  } finally {
    if (page) {
      await page.close();
    }
  }
}

/**
 * 将检查和更新的完整流程封装成一个函数
 * @param {object} pageInfo - Notion 页面对象
 * @param {import('playwright').Browser} browser - Playwright 浏览器实例
 */
async function processPage(pageInfo, browser) {
  const pageId = pageInfo.id;
  const title = pageInfo.properties.名称.title[0]?.plain_text || "无标题";
  const url = pageInfo.properties.链接.url;

  if (!url) {
    console.log(`⏭️  跳过: "${title}"，因为链接为空。`);
    return;
  }

  console.log(`--- 开始检查: "${title}" (${url}) ---`);
  const status = await checkUrlStatus(browser, url);
  
  // 更新 Notion 数据库
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        '状态': {
          status: { name: status },
        },
      },
    });
    console.log(`✅ [${title}] 更新成功，新状态: ${status}`);
  } catch (error) {
    console.error(`❌ [${title}] 更新 Notion 页面失败:`, error.body || error);
  }
}

/**
 * 主函数
 */
async function main() {
  console.log("🚀 开始执行链接检查任务 (Playwright 并行模式)...");
  
  const browser = await playwright.chromium.launch();
  
  try {
    let allPages = [];
    let nextCursor = undefined;
    console.log("正在获取数据库中的所有链接...");
    do {
      const response = await notion.databases.query({
        database_id: databaseId,
        start_cursor: nextCursor,
      });
      allPages.push(...response.results);
      nextCursor = response.next_cursor;
    } while (nextCursor);

    if (allPages.length === 0) {
      console.log("👍 数据库中没有找到任何链接，任务完成。");
      return;
    }
    
    console.log(`🔍 共找到 ${allPages.length} 个链接，将以 ${limit.concurrency} 的并发数开始检查。`);

    const promises = allPages.map(page => 
      limit(() => processPage(page, browser))
    );
    
    await Promise.all(promises);

    console.log("🎉 所有链接检查完毕！");

  } catch (error) {
    if (error.code) {
        console.error("❌ 执行主任务时发生 Notion API 错误:", error);
    } else {
        console.error("❌ 执行主任务时发生未知错误:", error);
    }
  } finally {
    await browser.close();
    console.log("浏览器已关闭。");
  }
}

main();
