const express = require('express');
const fetch = require('node-fetch');
const { pipeline } = require('stream/promises'); // 引入 pipeline 异步版
const router = express.Router();

const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

const createCorsHeaders = (init = {}) => ({
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  ...init
});

// 处理 OPTIONS
router.options('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(204).send();
});

function isAllowedKuwoHost(hostname) {
  return hostname && KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) return null;
    parsed.protocol = 'http:'; // 强制 http 兼容某些音源
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl, req, res) {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return res.status(400).set(createCorsHeaders()).send('Invalid target');
  }

  const abortController = new AbortController(); // 用于手动取消 fetch
  const init = {
    method: req.method,
    signal: abortController.signal,
    headers: {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Referer': 'https://www.kuwo.cn/',
    },
  };

  const rangeHeader = req.headers['range'];
  if (rangeHeader) init.headers['Range'] = rangeHeader;

  try {
    const upstream = await fetch(normalized.toString(), init);
    const headers = createCorsHeaders();
    
    SAFE_RESPONSE_HEADERS.forEach(h => {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    });

    res.writeHead(upstream.status, headers);

    // 【内存优化核心】:
    // 1. 监听客户端断开，立即停止从远端拉取数据
    req.on('close', () => {
      abortController.abort(); // 取消未完成的 fetch
      if (upstream.body) upstream.body.destroy(); // 销毁流
    });

    // 2. 使用 pipeline 替代 pipe，安全传输数据
    await pipeline(upstream.body, res);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('用户已断开或切歌，停止代理');
    } else {
      console.error('Proxy Stream Error:', error);
      if (!res.headersSent) res.status(500).send('Proxy error');
    }
  }
}

async function proxyApiRequest(req, res) {
  const apiUrl = new URL(API_BASE_URL);
  Object.keys(req.query).forEach(key => {
    if (key !== 'target' && key !== 'callback') apiUrl.searchParams.set(key, req.query[key]);
  });

  if (!apiUrl.searchParams.has('types')) {
    return res.status(400).set(createCorsHeaders()).send('Missing types');
  }

  try {
    const upstream = await fetch(apiUrl.toString(), {
      headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0' },
    });

    const headers = createCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8' });
    res.writeHead(upstream.status, headers);
    
    // API 请求通常较小，直接传输
    const data = await upstream.text();
    res.end(data);
  } catch (error) {
    console.error('API proxy error:', error);
    res.status(500).set(createCorsHeaders()).send('API proxy error');
  }
}

router.get('/', (req, res) => {
  const target = req.query.target;
  target ? proxyKuwoAudio(target, req, res) : proxyApiRequest(req, res);
});

module.exports = router;
