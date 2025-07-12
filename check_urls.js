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
 * 检查单个 URL 的有效性
 * @param {string} url - 需要检查的 URL
 * @returns {Promise<string>} - 返回链接的状态 (e.g., 'available', 'dead')
 */
async function checkUrlStatus(url) {
  if (!url) {
    return STATUS_MAP.error;
  }
  try {
    // 使用 HEAD 方法，效率更高，只请求头信息，不下载内容
    // 设置 10 秒超时和最多 5 次重定向
    const response = await axios.head(url, {
      timeout: 10000,
      maxRedirects: 5,
      // 伪装成浏览器，避免一些网站的 403 错误
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Axios 会自动处理重定向，最终状态码为 2xx 才算成功
    // 我们可以通过比较请求的最终 URL 和原始 URL 来判断是否发生了重定向
    if (response.request.res.responseUrl && response.request.res.responseUrl !== url) {
      return STATUS_MAP.redirect;
    }
    
    // 状态码在 200-299 之间都算成功
    if (response.status >= 200 && response.status < 300) {
      return STATUS_MAP.available;
    }
  } catch (error) {
    // 如果错误对象中有响应体，说明服务器返回了错误状态码
    if (error.response) {
      if (error.response.status === 404) {
        return STATUS_MAP.dead; // 明确是 404 死链
      }
      // 其他如 403, 500 等都归为通用错误
      return STATUS_MAP.error;
    }
    // 如果没有响应体，通常是网络层面的问题（如 DNS 错误，超时）
    return STATUS_MAP.error;
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
        '状态': { // 属性名必须与你的 Notion 数据库完全一致
          select: {
            name: newStatus,
          },
        },
      },
    });
    console.log(`✅ [${pageId}] 更新成功，新状态: ${newStatus}`);
  } catch (error) {
    console.error(`❌ [${pageId}] 更新 Notion 页面失败:`, error.body);
  }
}

/**
 * 主函数
 */
async function main() {
  console.log("🚀 开始执行链接检查任务...");
  try {
    // 查询数据库中所有“状态”为“未检测”的页面
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "状态",
        select: {
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

    // 遍历所有需要检查的页面
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
    console.error("❌ 执行主任务时发生严重错误:", error);
  }
}

// 运行主函数
main();
