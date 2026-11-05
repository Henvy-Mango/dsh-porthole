// lib/auth/login-template.js —— 局域网访问登录页
//
// 约束：
//   - 纯内联 HTML/CSS/JS，不引用任何外链资源（手机在局域网里常常没有外网）；
//   - 不依赖任何框架，体积 < 8KB，弱网下秒开；
//   - 跟随浏览器 Accept-Language 切换中英（此页渲染发生在 DSH 语言之前）。

/**
 * 按 Accept-Language 选登录页语言。
 * @param {string} [acceptLanguage]
 * @returns {'zh'|'en'}
 */
export function pickLoginLang(acceptLanguage) {
  const raw = String(acceptLanguage || '').toLowerCase();
  if (!raw) return 'zh';
  // 取第一个带明确权重的语言标签，中文优先判定
  if (raw.includes('zh')) return 'zh';
  if (raw.includes('en')) return 'en';
  return 'zh';
}

const COPY = {
  zh: {
    title: '远程访问验证',
    subtitle: '这台电脑上的 DeepSeek Harness 已开启访问保护',
    label: '访问密码',
    placeholder: '请输入访问密码',
    submit: '进入',
    submitting: '验证中…',
    noPassword: '尚未设置访问密码：直接点击「进入」即可。为安全起见，请尽快在控制台设置密码。',
    footer: '仅限同一局域网内的设备访问',
    wrong: '密码错误，请重试',
    locked: '尝试次数过多，请稍后再试',
  },
  en: {
    title: 'Remote access',
    subtitle: 'Access protection is enabled on this DeepSeek Harness host',
    label: 'Access password',
    placeholder: 'Enter access password',
    submit: 'Continue',
    submitting: 'Verifying…',
    noPassword: 'No password is set yet — just press Continue. Please set one from the console soon.',
    footer: 'Only reachable from devices on the same LAN',
    wrong: 'Incorrect password, please retry',
    locked: 'Too many attempts — try again later',
  },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 渲染登录页。
 * @param {object} opts
 * @param {boolean} [opts.hasPassword]
 * @param {boolean} [opts.locked] 当前 IP 是否已被封禁
 * @param {string} [opts.error] 服务端预置的错误文案（密码错误等）
 * @param {'zh'|'en'} [opts.lang]
 * @returns {string} HTML
 */
export function renderLoginPage({ hasPassword = true, locked = false, error = '', lang = 'zh' } = {}) {
  const t = COPY[lang] ?? COPY.zh;
  const initialError = error || (locked ? t.locked : '');
  // 固定登录入口（外部应用根，如 /dsh/）渲染本页时，登录接口与成功落点都用**相对路径**：
  //   - fetch('./__dsh_porthole__/login') 相对「当前登录入口所在目录」解析；
  //   - location.replace('./') 回到同一目录（即入口本身）。
  // 这样页面不需要知道对外前缀，也就不会把前缀补成 /dsh/dsh/ 或甩回站点根。
  const loginAction = './__dsh_porthole__/login';
  const afterLogin = './';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${t.title}</title>
<style>
:root{color-scheme:light dark;--bg:#0e1117;--card:#171b23;--fg:#e8ecf3;--muted:#93a0b4;--line:#2a3140;--acc:#4f6ef7;--warn:#f5a623;--err:#ff6b6b}
@media (prefers-color-scheme:light){:root{--bg:#f4f6fa;--card:#fff;--fg:#1a2029;--muted:#5d6b7e;--line:#e2e7ef}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px;box-shadow:0 12px 40px rgba(0,0,0,.18)}
h1{font-size:19px;margin:0 0 6px}
p.sub{margin:0 0 20px;color:var(--muted);font-size:13px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:16px;outline:none}
input:focus{border-color:var(--acc)}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:var(--acc);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
.msg{margin-top:12px;font-size:13px;color:var(--err);min-height:18px}
.note{margin-top:16px;padding:10px 12px;border-radius:10px;background:rgba(245,166,35,.12);color:var(--warn);font-size:12px;line-height:1.5}
footer{margin-top:20px;text-align:center;color:var(--muted);font-size:11px}
</style>
</head>
<body>
<form class="card" id="f" autocomplete="off">
  <h1>${t.title}</h1>
  <p class="sub">${t.subtitle}</p>
  <label for="pw">${t.label}</label>
  <input id="pw" name="password" type="password" placeholder="${t.placeholder}" ${locked ? 'disabled' : ''} autofocus inputmode="text" autocapitalize="off" autocorrect="off">
  <button type="submit" ${locked ? 'disabled' : ''}>${t.submit}</button>
  <div class="msg" id="m">${esc(initialError)}</div>
  ${hasPassword ? '' : `<div class="note">${t.noPassword}</div>`}
  <footer>${t.footer}</footer>
</form>
<script>
(function(){
  var f=document.getElementById('f'),inp=document.getElementById('pw'),btn=f.querySelector('button'),msg=document.getElementById('m');
  if(!inp)return;
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var pw=inp.value;
    btn.disabled=true;btn.textContent=${JSON.stringify(t.submitting)};msg.textContent='';
    fetch('${loginAction}',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
      .then(function(r){return r.json().catch(function(){return {ok:false,error:${JSON.stringify(t.wrong)}}});})
      .then(function(d){
        if(d&&d.ok){location.replace(${JSON.stringify(afterLogin)});return;}
        msg.textContent=(d&&d.error)||${JSON.stringify(t.wrong)};
        btn.disabled=false;btn.textContent=${JSON.stringify(t.submit)};
      })
      .catch(function(){
        msg.textContent=${JSON.stringify(t.wrong)};
        btn.disabled=false;btn.textContent=${JSON.stringify(t.submit)};
      });
  });
})();
</script>
</body>
</html>`;
}

/** 把服务端错误码本地化成用户可读文案。 */
export function localizeAuthError(error, lang = 'zh') {
  const t = COPY[lang] ?? COPY.zh;
  const text = String(error ?? '');
  if (/次数过多|too many|locked/i.test(text)) return t.locked;
  return text || t.wrong;
}
