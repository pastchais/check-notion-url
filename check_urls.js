// 引入所需的库
const { Client } = require("@notionhq/client");
const axios = require("axios");

// 从 GitHub Secrets 获取 Notion API 密钥和数据库 ID
const notionApiKey = process.env.NOTION_API_KEY;
const databaseId = process.env.NOTION_DATABASE_ID;

// 初始化 Notion 客户端
const notion = new Client({ auth: notionApiKey });

// 状态映射：将技术结果转换为 Notion 中的中文状态
const STATUS_MAP = {
  available: "可用",
  redirect: "重定向",
  dead: "已失效",
  error: "错误",
};

/**
 * 检查单个 URL 的有效性 (优化版，带 GET 备用方案)
 * @param {string} url - 需要检查的 URL
 * @returns {Promise<string>} - 返回链接的状态
 */
async function checkUrlStatus(url) {
  if (!url) {
    return STATUS_MAP.error;
  }

  // 定义通用的请求头，模拟浏览器
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  };

  // --- 第一次尝试: 使用高效的 HEAD 请求 ---
  try {
    const response = await axios.head(url, { timeout: 8000, maxRedirects: 5, headers });
    if (response.request.res.responseUrl && response.request.res.responseUrl !== url) {
      return STATUS_MAP.redirect;
    }
    if (response.status >= 200 && response.status < 300) {
      return STATUS_MAP.available;
    }
  } catch (headError) {
    // 如果 HEAD 请求返回 404，那基本可以确定是死链，无需重试
    if (headError.response && headError.response.status === 404) {
      console.log(`ℹ️  HEAD request confirmed 404 Not Found.`);
      return STATUS_MAP.dead;
    }
    
    // 对于其他错误 (如 403, 405, 超时等)，我们将降级使用 GET 请求重试
    console.log(`⚠️  HEAD request failed: ${headError.message}. Retrying with GET...`);

    // --- 第二次尝试: 使用兼容性更好的 GET 请求作为备用方案 ---
    try {
      const getResponse = await axios.get(url, { timeout: 15000, maxRedirects: 5, headers });
      if (getResponse.request.res.responseUrl && getResponse.request.res.responseUrl !== url) {
        return STATUS_MAP.redirect;
      }
      if (getResponse.status >= 200 && getResponse.status < 300) {
        return STATUS_MAP.available;
      }
    } catch (getError) {
      // 如果 GET 请求也失败了，我们采纳 GET 的失败结果
      if (getError.response) {
        console.error(`🔴 GET retry also failed with status ${getError.response.status}.`);
        return getError.response.status === 404 ? STATUS_MAP.dead : STATUS_MAP.error;
      }
      console.error(`🔴 GET retry also failed with network error: ${getError.message}.`);
      return STATUS_MAP.error; // 网络错误
    }
  }
  
  // 兜底的错误状态
  return STATUS_MAP.error;
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
          status: {
            name: newStatus,
          },
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
  console.log("🚀 开始执行链接检查任务...");
  try {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "状态",
        status: {
          equals: "未检测",
        },
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
      
      const status = await checkUrlStatus(url);
      await updateNotionPage(pageId, status);

      // 在每次检查之间加入短暂延时，避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 500)); 
    }
    console.log("🎉 所有链接检查完毕！");

  } catch (error) {
    if (error.code) {
        console.error("❌ 执行主任务时发生 Notion API 错误:", error);
    } else {
        console.error("❌ 执行主任务时发生未知错误:", error);
    }
  }
}

// 运行主函数
main();
