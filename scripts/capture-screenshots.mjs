/**
 * 三端界面截图：真实登录三个演示账号，各截一张首屏图，存到 docs/screenshots/。
 *
 * 用法（仓库根目录）：
 *   node scripts/capture-screenshots.mjs                       # 默认截线上站点
 *   node scripts/capture-screenshots.mjs http://localhost:5173 # 也可以截本地开发服务器
 *   node scripts/capture-screenshots.mjs <url> <输出目录>
 *
 * 实现方式：Node 拉起本机 Chrome 的无头模式，通过 CDP（DevTools 协议）驱动——
 * 填手机号与密码、点登录、等页面落到对应路由，再截图。不需要 playwright。
 * 依赖：本机装有 Chrome 或 Edge；仓库依赖里有 ws。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.argv[2] || 'https://jianwei-57i.pages.dev/'
const OUT_DIR = path.resolve(ROOT, process.argv[3] || 'docs/screenshots')
const PORT = Number(process.env.SHOT_PORT || 9333)
const VIEW = { width: 430, height: 932 }

const ROLES = [
  { key: 'customer', label: '顾客端', phone: '13800000001', route: '/customer', file: 'home-customer.png' },
  { key: 'merchant', label: '商家端', phone: '13800000002', route: '/merchant', file: 'home-merchant.png' },
  { key: 'rider', label: '骑手端', phone: '13800000003', route: '/rider', file: 'home-rider.png' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  const hit = candidates.find((p) => fs.existsSync(p))
  if (!hit) throw new Error('找不到 Chrome / Edge，可用 CHROME_PATH 指定')
  return hit
}

/** 极简 CDP 客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.waiting = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const slot = this.waiting.get(msg.id)
      if (slot) {
        this.waiting.delete(msg.id)
        msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result)
      }
    })
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      const detail =
        r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        JSON.stringify(r.exceptionDetails)
      throw new Error('页面内执行出错: ' + detail)
    }
    return r.result?.value
  }

  async waitFor(expression, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return true
      await sleep(300)
    }
    throw new Error('等待超时：' + what)
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
  }
}

/** 在页面里登录某个角色（与 e2e 冒烟脚本同一套选择器） */
function loginScript(role) {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const waitFor = async (fn, ms, what) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200); }
      throw new Error('等待超时: ' + what);
    };
    const setInput = (el, v) => {
      if (!el) throw new Error('找不到输入框');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const findAny = (txt) =>
      [...document.querySelectorAll('button,a')].find(e => (e.textContent || '').trim().includes(txt));
    const findBtnExact = (txt) =>
      [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === txt);

    await waitFor(() => document.body.innerText.includes('${role.label}'), 20000, '启动页');
    const card = findAny('${role.label}');
    if (!card) throw new Error('找不到「${role.label}」入口');
    card.click();
    await waitFor(() => document.querySelector('input[placeholder*="手机号"]'), 20000, '登录页');
    const pwdTab = findAny('密码');
    if (pwdTab) { pwdTab.click(); await sleep(400); }
    setInput(document.querySelector('input[placeholder*="手机号"]'), '${role.phone}');
    setInput(document.querySelector('input[type="password"]'), '123456');
    const agree = findAny('我已阅读并同意');
    if (agree) { agree.click(); await sleep(300); }
    const loginBtn = findBtnExact('登录');
    if (!loginBtn) throw new Error('找不到登录按钮');
    loginBtn.click();
    await waitFor(() => (location.hash || '').includes('${role.route}'), 30000, '登录落地 ${role.route}');
    window.scrollTo(0, 0);
    await sleep(3000);
    return location.hash;
  })()`
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = findBrowser()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-profile-'))
  console.log('浏览器:', browser)
  console.log('截取地址:', BASE)
  console.log('输出目录:', OUT_DIR)

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + profile,
      `--window-size=${VIEW.width},${VIEW.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    // 等 DevTools 端口就绪
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(400)
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch {
        /* 端口还没起来 */
      }
    }
    if (!target) throw new Error('DevTools 端口没起来')

    const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width,
      height: VIEW.height,
      deviceScaleFactor: 2,
      mobile: true,
    })

    const results = []
    for (const role of ROLES) {
      process.stdout.write(`→ ${role.label} ... `)
      // 每个角色用干净会话，避免登录态串端：
      // 先导航到站点（about:blank 上读 localStorage 会抛 SecurityError），清掉会话后再重新加载
      await cdp.send('Page.navigate', { url: BASE })
      await sleep(1500)
      await cdp.evaluate('try { localStorage.clear(); sessionStorage.clear() } catch (e) {} ; true')
      await cdp.send('Page.navigate', { url: BASE })
      const hash = await cdp.evaluate(loginScript(role))
      const file = path.join(OUT_DIR, role.file)
      await cdp.screenshot(file)
      console.log(`✅ ${role.file}（落在 ${hash}，${Math.round(fs.statSync(file).size / 1024)} KB）`)
      results.push({ role: role.label, file: role.file })
    }
    console.log('\n完成：')
    results.forEach((r) => console.log('  ' + r.role + ' -> ' + r.file))
  } finally {
    try { child.kill() } catch { /* ignore */ }
    await sleep(500)
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('\n✗ 截图失败:', e.message)
  process.exit(1)
})
