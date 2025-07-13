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
 * [NEW] 删除 (存档) 一个 Notion 页面
 * @param {object} pageInfo - 要删除的 Notion 页面对象
 */
async function deletePage(pageInfo) {
    const pageId = pageInfo.id;
    const title = pageInfo.properties.名称.title[0]?.plain_text || "无标题";
    const url = pageInfo.properties.链接.url;

    console.log(`🗑️  准备删除重复页面: "${title}" (${url})`);
    try {
        await notion.pages.update({
            page_id: pageId,
            archived: true, // 存档页面即为删除
        });
        console.log(`✅ [${title}] 重复页面已成功删除。`);
    } catch (error) {
        console.error(`❌ [${title}] 删除 Notion 页面失败:`, error.body || error);
    }
}


/**
 * 主函数
 */
async function main() {
  console.log("🚀 开始执行链接维护任务 (包含重复检查和状态更新)...");

  let browser;
  try {
    // --- 1. 获取所有页面 ---
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
    console.log(`🔍 共找到 ${allPages.length} 个页面。`);


    // --- 2. 检查并处理重复项 ---
    console.log("\n🧐 开始检查重复链接...");
    const urlMap = new Map();
    allPages.forEach(page => {
        const url = page.properties.链接.url;
        if (url) { // 只处理有链接的页面
            if (!urlMap.has(url)) {
                urlMap.set(url, []);
            }
            urlMap.get(url).push(page);
        }
    });

    const pagesToDelete = [];
    const uniquePagesToProcess = [];

    for (const [url, pages] of urlMap.entries()) {
        if (pages.length > 1) {
            console.log(`⚠️ 发现重复链接: "${url}" (${pages.length} 次)`);
            // 保留第一个，将其余的加入删除列表
            uniquePagesToProcess.push(pages[0]);
            pagesToDelete.push(...pages.slice(1));
        } else {
            // 没有重复的，直接加入处理列表
            uniquePagesToProcess.push(pages[0]);
        }
    }

    if (pagesToDelete.length > 0) {
        console.log(`\n🗑️ 将删除 ${pagesToDelete.length} 个重复页面...`);
        const deletePromises = pagesToDelete.map(page =>
            limit(() => deletePage(page))
        );
        await Promise.all(deletePromises);
        console.log("✅ 所有重复页面处理完毕。");
    } else {
        console.log("👍 没有发现重复链接。");
    }
    

    // --- 3. 检查剩余唯一链接的状态 ---
    console.log(`\n🔍 将以 ${limit.concurrency} 的并发数开始检查 ${uniquePagesToProcess.length} 个唯一链接的状态。`);
    
    // 仅在需要检查链接时才启动浏览器
    if (uniquePagesToProcess.length > 0) {
        browser = await playwright.chromium.launch();
        const checkPromises = uniquePagesToProcess.map(page =>
          limit(() => processPage(page, browser))
        );
        await Promise.all(checkPromises);
    }

    console.log("\n🎉 所有任务执行完毕！");

  } catch (error) {
    if (error.code) {
        console.error("❌ 执行主任务时发生 Notion API 错误:", error);
    } else {
        console.error("❌ 执行主任务时发生未知错误:", error);
    }
  } finally {
    if (browser) {
        await browser.close();
        console.log("浏览器已关闭。");
    }
  }
}

main();
