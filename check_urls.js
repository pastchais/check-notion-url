// 引入所需的库
const { Client } = require("@notionhq/client");
const playwright = require("playwright");

// 从 GitHub Secrets 获取 Notion API 密钥和数据库 ID
const notionApiKey = process.env.NOTION_API_KEY;
const databaseId = process.env.NOTION_DATABASE_ID;

// 初始化 Notion 客户端
const notion = new Client({ auth: notionApiKey });

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
    // 创建一个新的浏览器页面
    page = await browser.newPage({
      // 模拟一个常见的浏览器 User-Agent
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    });

    // 导航到目标 URL，等待页面加载完成
    // waitUntil: 'domcontentloaded' 是一个很好的平衡点，无需等待所有图片加载
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    const finalUrl = page.url();
    const status = response.status();

    // 检查是否发生重定向
    if (finalUrl !== url && finalUrl !== url + '/') {
      return STATUS_MAP.redirect;
    }
    
    // 检查状态码
    if (status >= 200 && status < 400) { // 2xx 和 3xx 都认为是可访问的
      return STATUS_MAP.available;
    } else if (status === 404) {
      return STATUS_MAP.dead;
    } else {
      // 其他 4xx 或 5xx 错误
      return STATUS_MAP.error;
    }

  } catch (error) {
    console.error(`🔴 检查 "${url}" 时发生 Playwright 错误: ${error.message}`);
    // 根据错误信息判断是否为死链
    if (error.message.includes('404')) {
      return STATUS_MAP.dead;
    }
    return STATUS_MAP.error;
  } finally {
    // 无论成功与否，都关闭页面
    if (page) {
      await page.close();
    }
  }
}

/**
 * 更新 Notion 页面
 * @param {string} pageId - Notion 页面的 ID
 * @param {string} newStatus - 新的状态
 */
async function updateNotionPage(pageId, newStatus) {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        '状态': {
          status: { name: newStatus },
        },
      },
    });
    console.log(`✅ [${pageId}] 更新成功，新状态: ${newStatus}`);
  } catch (error) {
    console.error(`❌ [${pageId}] 更新 Notion 页面失败:`, error.body || error);
  }
}

/**
 * 主函数
 */
async function main() {
  console.log("🚀 开始执行链接检查任务 (Playwright 健壮模式)...");
  
  // --- 关键优化：只启动一次浏览器 ---
  const browser = await playwright.chromium.launch();
  
  try {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "状态",
        status: { equals: "未检测" },
      },
    });

    const pages = response.results;
    if (pages.length === 0) {
      console.log("👍 没有找到需要检查的链接，任务完成。");
      return;
    }
    
    console.log(`🔍 找到 ${pages.length} 个需要检查的链接。`);

    for (const page of pages) {
      const pageId = page.id;
      const title = page.properties.名称.title[0]?.plain_text || "无标题";
      const url = page.properties.链接.url;

      console.log(`--- 开始检查: "${title}" (${url}) ---`);
      
      // 将浏览器实例传递给检查函数
      const status = await checkUrlStatus(browser, url);
      await updateNotionPage(pageId, status);

      // 短暂延时，行为更像人类
      await new Promise(resolve => setTimeout(resolve, 1000)); 
    }
    console.log("🎉 所有链接检查完毕！");

  } catch (error) {
    if (error.code) {
        console.error("❌ 执行主任务时发生 Notion API 错误:", error);
    } else {
        console.error("❌ 执行主任务时发生未知错误:", error);
    }
  } finally {
    // --- 关键优化：任务结束后关闭浏览器 ---
    await browser.close();
    console.log("浏览器已关闭。");
  }
}

main();
