// Notisnap CORS Proxy — Cloudflare Worker
// デプロイ手順:
//   1. https://dash.cloudflare.com → Workers & Pages → Create Worker
//   2. このファイルの内容を貼り付けてデプロイ
//   3. Worker の URL（例: https://notisnap-proxy.xxx.workers.dev）をアプリの設定に入力

export default {
  async fetch(request) {
    // CORS プリフライト
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
        }
      });
    }

    const url = new URL(request.url);
    const notionUrl = 'https://api.notion.com' + url.pathname + url.search;

    const headers = {
      'Notion-Version': request.headers.get('Notion-Version') || '2022-06-28',
    };
    if (request.headers.get('Authorization')) headers['Authorization'] = request.headers.get('Authorization');
    if (request.headers.get('Content-Type')) headers['Content-Type'] = request.headers.get('Content-Type');

    const response = await fetch(notionUrl, {
      method: request.method,
      headers,
      body: ['POST', 'PATCH', 'PUT'].includes(request.method) ? request.body : null,
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};
