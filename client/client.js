window.__ModuleLoader__.load({
  id: "dsh-porthole",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.js
var index_exports = {};
__export(index_exports, {
  BridgePanel: () => BridgePanel,
  EP: () => EP,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var name = "dsh-porthole";
var inject = ["slots", "connection"];
var BRIDGE_RPC_CHANNEL = "/dsh-porthole";
var ENDPOINT_PREFIX = "/__dsh_porthole__";
var EP = {
  getStatus: "getStatus",
  setPort: "setPort",
  restartProxy: "restartProxy",
  setProxyConfig: "setProxyConfig",
  getQr: "getQr",
  diagnose: "diagnose",
  authGetStatus: "authGetStatus",
  authUpdateConfig: "authUpdateConfig",
  authRegenerateToken: "authRegenerateToken",
  authAdminUnlock: "authAdminUnlock",
  authAdminLock: "authAdminLock",
  // 远程工作区管理
  listWorkspaces: "listWorkspaces",
  listRemoteDirectories: "listRemoteDirectories",
  addRemoteWorkspace: "addRemoteWorkspace"
};
var h = (type, props, ...children) => React.createElement(type, props, ...children);
var S = {
  card: {
    background: "var(--dsw-alias-bg-layer-2,#f9fafb)",
    border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)",
    borderRadius: 12,
    padding: "16px 18px",
    marginBottom: 16,
    boxSizing: "border-box"
  },
  title: { fontSize: 14, fontWeight: 600, margin: "0 0 12px 0" },
  row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  label: { fontSize: 13, color: "var(--dsw-alias-fg-l3,#6b7280)", minWidth: 84 },
  mono: { fontSize: 13, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", wordBreak: "break-all" },
  input: {
    flex: 1,
    minWidth: 120,
    padding: "7px 10px",
    fontSize: 13,
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)",
    background: "var(--dsw-alias-bg-layer-1,#fff)",
    color: "inherit",
    boxSizing: "border-box"
  },
  btn: {
    padding: "7px 14px",
    fontSize: 13,
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)",
    background: "var(--dsw-alias-bg-layer-1,#fff)",
    color: "inherit",
    cursor: "pointer"
  },
  btnPrimary: {
    padding: "7px 14px",
    fontSize: 13,
    borderRadius: 8,
    border: "1px solid #4f6ef7",
    background: "#4f6ef7",
    color: "#fff",
    cursor: "pointer"
  },
  btnDanger: {
    padding: "7px 14px",
    fontSize: 13,
    borderRadius: 8,
    border: "1px solid #dc2626",
    background: "transparent",
    color: "#dc2626",
    cursor: "pointer"
  },
  hint: { fontSize: 12, color: "var(--dsw-alias-fg-l3,#6b7280)", lineHeight: 1.6, margin: "8px 0 0" },
  ok: { color: "#16a34a", fontSize: 12 },
  bad: { color: "#dc2626", fontSize: 12 },
  warn: { color: "#d97706", fontSize: 12 },
  qr: { width: 168, height: 168, borderRadius: 8, background: "#fff", padding: 6 },
  locked: {
    background: "rgba(217,119,6,.1)",
    border: "1px solid rgba(217,119,6,.4)",
    borderRadius: 10,
    padding: "12px 14px",
    marginBottom: 16
  }
};
function Row({ label, children }) {
  return h("div", { style: S.row }, h("span", { style: S.label }, label), children);
}
function Card({ title, children }) {
  return h("div", { style: S.card }, h("h3", { style: S.title }, title), children);
}
var MODE_LABELS = {
  token_and_password: "\u5BC6\u7801 + \u626B\u7801\u4EE4\u724C",
  password_only: "\u4EC5\u5BC6\u7801",
  token_only: "\u4EC5\u626B\u7801\u4EE4\u724C"
};
var POLICY_LABELS = {
  password_unlock: "\u5C40\u57DF\u7F51\u53EF\u89E3\u9501\uFF08\u63A8\u8350\uFF09",
  local_only: "\u4EC5\u9650\u7535\u8111\u672C\u673A",
  open: "\u4E0D\u8BBE\u9632\uFF08\u5371\u9669\uFF09"
};
function BridgePanel({ rpcCall, initialStatus, initialAdminToken }) {
  const [status, setStatus] = React.useState(initialStatus ?? null);
  const [qr, setQr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [diag, setDiag] = React.useState(null);
  const [adminToken, setAdminToken] = React.useState(initialAdminToken ?? null);
  const [adminPassword, setAdminPassword] = React.useState("");
  const [unlockErr, setUnlockErr] = React.useState(null);
  const [adminAutoFetchError, setAdminAutoFetchError] = React.useState(null);
  const [guestPassword, setGuestPassword] = React.useState("");
  const [adminPasswordNew, setAdminPasswordNew] = React.useState("");
  const [portVal, setPortVal] = React.useState("");
  const [basePathVal, setBasePathVal] = React.useState("");
  const [proxyMsg, setProxyMsg] = React.useState(null);
  const [hostVal, setHostVal] = React.useState("0.0.0.0");
  const [wsList, setWsList] = React.useState(null);
  const [browse, setBrowse] = React.useState(null);
  const [browseErr, setBrowseErr] = React.useState(null);
  const [adding, setAdding] = React.useState(false);
  const auth = status?.auth;
  const needUnlock = Boolean(auth && (auth.hasPassword || auth.hasAdminPassword) && auth.adminProtection !== false && auth.adminPolicy !== "open" && !adminToken);
  const refresh = React.useCallback(async (withToken) => {
    try {
      const res = await rpcCall(EP.getStatus, { adminToken: withToken ?? void 0 });
      if (res?.ok) {
        setStatus(res.value);
        setPortVal(String(res.value.proxy.port));
        setBasePathVal(res.value.basePath || "");
        setHostVal(res.value.host || "0.0.0.0");
        return res.value;
      }
      setMsg({ kind: "bad", text: res?.error?.message ?? "\u8BFB\u53D6\u72B6\u6001\u5931\u8D25" });
      return null;
    } catch (err) {
      setMsg({ kind: "bad", text: `\u8BFB\u53D6\u72B6\u6001\u5931\u8D25\uFF1A${err?.message ?? err}` });
      return null;
    }
  }, [rpcCall]);
  const loadQr = React.useCallback(async (withToken) => {
    try {
      const res = await rpcCall(EP.getQr, { adminToken: withToken ?? void 0 });
      if (res?.ok) setQr(res.value);
    } catch {
    }
  }, [rpcCall]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await refresh();
      if (cancelled || !s) return;
      void loadQr();
      const host = window.location?.hostname || "";
      const protocol = window.location?.protocol || "";
      const isDesktopShell = protocol === "dsh-app:";
      const isLocalHost = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "";
      if (!isLocalHost && !isDesktopShell || !s.proxy?.port) return;
      const boundHost = s.host && s.host !== "0.0.0.0" ? s.host : null;
      const targetHost = boundHost || (isDesktopShell ? "127.0.0.1" : host);
      try {
        const resp = await fetch(`http://${targetHost}:${s.proxy.port}${ENDPOINT_PREFIX}/loopback-token`, {
          credentials: "omit"
        });
        if (!resp.ok) {
          setAdminAutoFetchError(
            resp.status === 403 ? "\u672C\u673A\u4EE4\u724C\u88AB\u62D2\u7EDD\uFF08\u6765\u6E90\u4E0D\u5728\u767D\u540D\u5355\uFF09\u3002\u53EF\u5728\u300C\u5B89\u5168\u8BA4\u8BC1\u300D\u91CC\u8F93\u7BA1\u7406\u5BC6\u7801\u89E3\u9501\u3002" : `\u672C\u673A\u4EE4\u724C\u83B7\u53D6\u5931\u8D25\uFF08HTTP ${resp.status}\uFF09\uFF0C\u8BF7\u7528\u7BA1\u7406\u5BC6\u7801\u89E3\u9501\u3002`
          );
          return;
        }
        const data = await resp.json();
        if (data?.ok && data.adminToken && !cancelled) {
          setAdminToken(data.adminToken);
          setAdminAutoFetchError(null);
          await refresh(data.adminToken);
          await loadQr(data.adminToken);
        }
      } catch (err) {
        if (!cancelled) {
          setAdminAutoFetchError(`\u65E0\u6CD5\u8FDE\u63A5\u95E8\u6237\u7AEF\u53E3 ${s.proxy?.port}\uFF08${err?.message ?? err}\uFF09\uFF0C\u8BF7\u7528\u7BA1\u7406\u5BC6\u7801\u89E3\u9501\u3002`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, loadQr]);
  const call = async (endpoint, payload) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await rpcCall(endpoint, { ...payload ?? {}, adminToken: adminToken ?? void 0 });
      if (res?.ok) {
        const invalidatesAdmin = endpoint === EP.authUpdateConfig && (payload?.mode !== void 0 || payload?.adminPolicy !== void 0 || payload?.password !== void 0);
        if (invalidatesAdmin) {
          setAdminToken(null);
          await refresh();
          await loadQr();
          setMsg({ kind: "ok", text: "\u5DF2\u4FDD\u5B58\u3002\u5B89\u5168\u7B56\u7565\u53D8\u66F4\u4F1A\u91CD\u7F6E\u767B\u5F55\u6001\uFF0C\u8BF7\u91CD\u65B0\u89E3\u9501\u7BA1\u7406\u5458\u4EE5\u7EE7\u7EED\u4FEE\u6539\u3002" });
        } else {
          await refresh(adminToken);
        }
        return res.value;
      }
      const text = res?.error?.message ?? "\u64CD\u4F5C\u5931\u8D25";
      setMsg({ kind: "bad", text });
      if (/管理员|解锁|仅限电脑本机/.test(text)) setAdminToken(null);
      return null;
    } catch (err) {
      setMsg({ kind: "bad", text: `\u64CD\u4F5C\u5931\u8D25\uFF1A${err?.message ?? err}` });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const doUnlock = async () => {
    setBusy(true);
    setUnlockErr(null);
    try {
      const res = await rpcCall(EP.authAdminUnlock, { password: adminPassword });
      if (res?.ok && res.value?.adminToken) {
        setAdminToken(res.value.adminToken);
        setAdminPassword("");
        setMsg({ kind: "ok", text: "\u5DF2\u89E3\u9501\u7BA1\u7406\u5458\uFF0C\u73B0\u5728\u53EF\u4EE5\u4FEE\u6539\u5B89\u5168\u914D\u7F6E" });
        await refresh(res.value.adminToken);
        await loadQr(res.value.adminToken);
      } else {
        setUnlockErr(res?.error?.message ?? "\u7BA1\u7406\u5458\u5BC6\u7801\u9519\u8BEF");
      }
    } catch (err) {
      setUnlockErr(err?.message ?? "\u7BA1\u7406\u5458\u5BC6\u7801\u9519\u8BEF");
    } finally {
      setBusy(false);
    }
  };
  const doLock = async () => {
    try {
      await rpcCall(EP.authAdminLock, { adminToken });
    } catch {
    }
    setAdminToken(null);
    setMsg({ kind: "ok", text: "\u5DF2\u9501\u5B9A\u7BA1\u7406\u5458" });
    await refresh();
    await loadQr();
  };
  React.useEffect(() => {
    if (!adminToken) {
      setWsList(null);
      setBrowse(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await rpcCall(EP.listWorkspaces, { adminToken });
        if (!cancelled && res?.ok) setWsList(res.value ?? []);
      } catch {
      }
      try {
        const res = await rpcCall(EP.listRemoteDirectories, { adminToken });
        if (!cancelled) {
          if (res?.ok) setBrowse(res.value);
          else setBrowseErr(res?.error?.message ?? "\u76EE\u5F55\u6D4F\u89C8\u5931\u8D25");
        }
      } catch (err) {
        if (!cancelled) setBrowseErr(err?.message ?? "\u76EE\u5F55\u6D4F\u89C8\u5931\u8D25");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminToken, rpcCall]);
  const browseTo = async (path) => {
    setBrowseErr(null);
    try {
      const res = await rpcCall(EP.listRemoteDirectories, { path, adminToken: adminToken ?? void 0 });
      if (res?.ok) {
        setBrowse(res.value);
        if (res.value?.workspaces) setWsList(res.value.workspaces);
      } else {
        setBrowseErr(res?.error?.message ?? "\u76EE\u5F55\u6D4F\u89C8\u5931\u8D25");
        if (/管理员|解锁/.test(res?.error?.message ?? "")) setAdminToken(null);
      }
    } catch (err) {
      setBrowseErr(err?.message ?? "\u76EE\u5F55\u6D4F\u89C8\u5931\u8D25");
    }
  };
  const addToWorkspace = async (path) => {
    setAdding(true);
    setBrowseErr(null);
    try {
      const res = await rpcCall(EP.addRemoteWorkspace, { path, adminToken: adminToken ?? void 0 });
      if (res?.ok && res.value?.ok) {
        setWsList(res.value.workspaces ?? []);
        setMsg({ kind: "ok", text: `\u5DF2\u6DFB\u52A0\u5DE5\u4F5C\u533A\uFF1A${res.value.title}` });
      } else {
        const text = res?.error?.message ?? res?.value?.error ?? "\u6DFB\u52A0\u5931\u8D25";
        setBrowseErr(text);
        if (/管理员|解锁/.test(text)) setAdminToken(null);
      }
    } catch (err) {
      setBrowseErr(err?.message ?? "\u6DFB\u52A0\u5931\u8D25");
    } finally {
      setAdding(false);
    }
  };
  const runDiagnose = async () => {
    try {
      const res = await rpcCall(EP.diagnose, {});
      if (res?.ok) setDiag(res.value?.checks ?? []);
      else setMsg({ kind: "bad", text: res?.error?.message ?? "\u81EA\u68C0\u5931\u8D25" });
    } catch (err) {
      setMsg({ kind: "bad", text: `\u81EA\u68C0\u5931\u8D25\uFF1A${err?.message ?? err}` });
    }
  };
  if (!status) {
    return h(
      "div",
      { style: S.card },
      h("h3", { style: S.title }, "\u5C40\u57DF\u7F51\u8BBF\u95EE"),
      msg?.kind === "bad" ? h(
        "div",
        null,
        h("div", { style: { ...S.bad, marginBottom: 10 } }, msg.text),
        h("button", { style: S.btn, onClick: () => void refresh() }, "\u91CD\u8BD5"),
        h("p", { style: S.hint }, "\u82E5\u6301\u7EED\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4 DSH \u4E3B\u8FDB\u7A0B\u4ECD\u5728\u8FD0\u884C\uFF0C\u7136\u540E\u91CD\u542F\u63D2\u4EF6\u3002")
      ) : h("div", { style: { fontSize: 13 } }, "\u6B63\u5728\u8BFB\u53D6\u5C40\u57DF\u7F51\u8BBF\u95EE\u72B6\u6001\u2026")
    );
  }
  const { proxy, lan } = status;
  const previewUrl = (() => {
    const base = `http://${lan.ip || "127.0.0.1"}:${proxy.port}`;
    let p = String(basePathVal || "").trim();
    if (!p || p === "/") return `${base}/`;
    if (!p.startsWith("/")) p = `/${p}`;
    p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    return `${base}${p}/`;
  })();
  const lanUrl = lan.url;
  return h(
    "div",
    null,
    // ---- 管理员锁定条 ----
    needUnlock ? h(
      "div",
      { style: S.locked },
      h(
        "div",
        { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
        "\u{1F512} \u5B89\u5168\u914D\u7F6E\u5DF2\u9501\u5B9A"
      ),
      h(
        "div",
        { style: { ...S.hint, margin: "0 0 10px" } },
        "\u4FEE\u6539\u8BA4\u8BC1\u6A21\u5F0F\u3001\u5BC6\u7801\u3001\u9632\u7BE1\u6539\u7B56\u7565\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650\u3002" + (auth.adminPolicy === "local_only" ? "\u5F53\u524D\u7B56\u7565\u4E3A\u300C\u4EC5\u9650\u7535\u8111\u672C\u673A\u300D\uFF0C\u8BF7\u5728\u7535\u8111\u4E0A\u7528 127.0.0.1 \u6253\u5F00\u672C\u9875\u9762\u3002" : "\u8BF7\u8F93\u5165\u7BA1\u7406\u5BC6\u7801\u89E3\u9501\uFF08\u672A\u5355\u72EC\u8BBE\u7F6E\u7BA1\u7406\u5BC6\u7801\u65F6\uFF0C\u8F93\u5165\u8BBF\u95EE\u5BC6\u7801\u5373\u53EF\uFF09\u3002")
      ),
      // 本机自动领取令牌失败时说明原因，否则用户只会看到"要输密码"却不知为何
      adminAutoFetchError ? h(
        "div",
        { style: { ...S.warn, fontSize: 12, marginBottom: 8 } },
        `\u672C\u673A\u81EA\u52A8\u89E3\u9501\u5931\u8D25\uFF1A${adminAutoFetchError}`
      ) : null,
      auth.adminPolicy === "local_only" ? null : h(
        "div",
        { style: S.row },
        h("input", {
          style: S.input,
          type: "password",
          placeholder: "\u7BA1\u7406\u5BC6\u7801",
          value: adminPassword,
          onChange: (e) => setAdminPassword(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") void doUnlock();
          }
        }),
        h("button", {
          style: S.btnPrimary,
          disabled: busy || !adminPassword,
          onClick: () => void doUnlock()
        }, "\u89E3\u9501")
      ),
      unlockErr ? h("div", { style: S.bad }, unlockErr) : null
    ) : null,
    msg ? h("div", { style: msg.kind === "bad" ? { ...S.bad, marginBottom: 12 } : { ...S.ok, marginBottom: 12 }, role: "alert" }, msg.text) : null,
    // ---------------- 1. 局域网访问 ----------------
    h(
      Card,
      { title: "\u5C40\u57DF\u7F51\u8BBF\u95EE" },
      h(
        Row,
        { label: "\u8BBF\u95EE\u5730\u5740" },
        h("span", { style: S.mono }, lanUrl ?? "\u672A\u627E\u5230\u53EF\u7528\u7F51\u5361"),
        lanUrl ? h("button", {
          style: S.btn,
          onClick: () => navigator.clipboard?.writeText(lanUrl)
        }, "\u590D\u5236") : null
      ),
      h(
        Row,
        { label: "\u72B6\u6001" },
        h(
          "span",
          { style: proxy.running ? S.ok : S.bad },
          proxy.running ? `\u8FD0\u884C\u4E2D \xB7 ${status.host || "0.0.0.0"}:${proxy.port} \xB7 ${proxy.activeConnections} \u4E2A\u8FDE\u63A5` : proxy.error || "\u672A\u8FD0\u884C"
        ),
        h("button", {
          style: S.btn,
          disabled: busy,
          onClick: () => void call(EP.restartProxy, {})
        }, "\u91CD\u542F\u4EE3\u7406")
      ),
      qr?.dataUrl ? h(
        Row,
        { label: "\u626B\u7801" },
        h("img", { src: qr.dataUrl, alt: "\u5C40\u57DF\u7F51\u8BBF\u95EE\u4E8C\u7EF4\u7801", style: S.qr })
      ) : qr?.url ? h(
        Row,
        { label: "\u626B\u7801" },
        h("span", { style: S.hint }, "\u89E3\u9501\u7BA1\u7406\u5458\u540E\u53EF\u751F\u6210\u514D\u5BC6\u4E8C\u7EF4\u7801\uFF08\u5F53\u524D\u53EA\u663E\u793A\u5730\u5740\uFF09")
      ) : null,
      // 「网卡」行已移除：它与「监听地址」职责重叠。对外展示的 IP 现在直接跟随监听地址
      // （绑具体地址就用它；绑 0.0.0.0 时自动挑最佳局域网 IP）。
      h(
        Row,
        { label: "\u7AEF\u53E3" },
        h("input", {
          style: S.input,
          value: portVal,
          inputMode: "numeric",
          onChange: (e) => setPortVal(e.target.value.replace(/[^\d]/g, ""))
        }),
        h("button", {
          style: S.btn,
          disabled: busy,
          onClick: () => void call(EP.setPort, { port: Number(portVal) })
        }, "\u5E94\u7528")
      ),
      // ---- 二级目录（挂载前缀）----
      // 设了前缀即强制生效：只放行该前缀下的路径，未挂载路径一律拒绝（无开关）。
      h(
        Row,
        { label: "\u4E8C\u7EA7\u76EE\u5F55" },
        h("input", {
          style: S.input,
          placeholder: "\u7559\u7A7A = \u7AD9\u70B9\u6839\uFF1B\u586B /dsh \u8868\u793A http://IP:\u7AEF\u53E3/dsh/",
          value: basePathVal,
          disabled: busy,
          onChange: (e) => setBasePathVal(e.target.value)
        })
      ),
      h(
        Row,
        { label: "\u76D1\u542C\u5730\u5740" },
        h(
          "select",
          {
            style: S.input,
            value: hostVal,
            disabled: busy,
            onChange: (e) => setHostVal(e.target.value)
          },
          h("option", { value: "0.0.0.0" }, "0.0.0.0\uFF08\u5168\u90E8\u7F51\u5361\uFF0C\u9ED8\u8BA4\uFF09"),
          h("option", { value: "127.0.0.1" }, "127.0.0.1\uFF08\u4EC5\u672C\u673A\uFF09"),
          ...(lan.interfaces ?? []).map((i) => h("option", { key: i.address, value: i.address }, i.address)),
          ...hostVal && hostVal !== "0.0.0.0" && hostVal !== "127.0.0.1" && !(lan.interfaces ?? []).some((i) => i.address === hostVal) ? [h("option", { key: "__missing__", value: hostVal }, `${hostVal}\uFF08\u5F53\u524D\u4E0D\u53EF\u7528\uFF09`)] : []
        )
      ),
      h(
        Row,
        { label: "" },
        h("button", {
          style: S.btnPrimary,
          disabled: busy,
          onClick: async () => {
            setProxyMsg(null);
            const v = await call(EP.setProxyConfig, {
              basePath: basePathVal,
              host: hostVal
            });
            if (v) {
              setProxyMsg({
                kind: "ok",
                text: `\u5DF2\u4FDD\u5B58\uFF1A\u6302\u5728 ${v.basePath || "\u7AD9\u70B9\u6839"}\uFF0C\u76D1\u542C ${v.host}\u3002\u8BF7\u7528 ${previewUrl} \u8BBF\u95EE\u3002`
              });
            } else {
              setProxyMsg({ kind: "bad", text: msg?.text || "\u4FDD\u5B58\u5931\u8D25\uFF0C\u539F\u56E0\u89C1\u9762\u677F\u9876\u90E8\u63D0\u793A" });
            }
          }
        }, "\u4FDD\u5B58\u6302\u8F7D\u8BBE\u7F6E")
      ),
      proxyMsg ? h(
        "div",
        { style: { ...proxyMsg.kind === "ok" ? S.ok : S.bad, margin: "0 0 8px", lineHeight: 1.6 } },
        proxyMsg.text
      ) : null,
      h(
        "p",
        { style: { ...S.hint, margin: "0 0 6px" } },
        "\u5C06\u4ECE\u6B64\u5730\u5740\u8BBF\u95EE\uFF1A",
        h("span", { style: S.mono }, previewUrl)
      ),
      h(
        "p",
        { style: { ...S.warn, margin: "0 0 6px" } },
        "\u26A0\uFE0F \u4E8C\u7EA7\u76EE\u5F55\u662F URL \u8DEF\u5F84\u524D\u7F00\uFF0C\u4E0D\u662F\u57DF\u540D\uFF1A\u8981\u5199 /dsh\uFF0C\u4E0D\u8981\u5199 -DSH \u6216 dsh.example.com\u3002"
      ),
      h(
        "p",
        { style: { ...S.hint, margin: "0 0 6px" } },
        "\u9009 0.0.0.0 \u65F6\u6240\u6709\u5730\u5740\u90FD\u80FD\u8BBF\u95EE\uFF1B\u9009\u5177\u4F53 IP \u65F6\u53EA\u6709\u8BE5\u5730\u5740\u80FD\u8BBF\u95EE\uFF0C\u8BBF\u95EE\u5730\u5740\u4E5F\u4F1A\u8DDF\u7740\u53D8\u3002"
      ),
      basePathVal.trim() ? h(
        "p",
        { style: { ...S.warn, margin: "0 0 6px" } },
        "\u8BBE\u5B9A\u540E\u53EA\u5141\u8BB8\u4ECE\u8BE5\u76EE\u5F55\u8BBF\u95EE\uFF1A\u6839\u8DEF\u5F84\u4F1A\u81EA\u52A8\u8DF3\u8F6C\u5230\u5B83\uFF0C\u5176\u5B83\u672A\u6302\u8F7D\u8DEF\u5F84\u8FD4\u56DE 404\u3002\u82E5\u524D\u9762\u6709 nginx\uFF0C\u8BF7\u4E0D\u8981\u8BA9\u5B83\u518D\u5265\u524D\u7F00\uFF08proxy_pass http://127.0.0.1:<\u7AEF\u53E3>; \u4E0D\u5E26\u5C3E\u659C\u6760\uFF09\u3002"
      ) : null,
      h(
        "p",
        { style: S.hint },
        "\u540C\u4E00 Wi-Fi / \u5C40\u57DF\u7F51\u4E0B\u7684\u624B\u673A\u3001\u5E73\u677F\u3001\u5176\u5B83\u7535\u8111\uFF0C\u6253\u5F00\u4E0A\u9762\u7684\u5730\u5740\u5373\u53EF\u7EE7\u7EED\u4F7F\u7528\u8FD9\u53F0\u7535\u8111\u4E0A\u7684 DSH\u3002\u626B\u7801\u53EA\u5728\u5C40\u57DF\u7F51\u5185\u6709\u6548\uFF1A\u8DEF\u7531\u5668\u4E0D\u505A\u7AEF\u53E3\u6620\u5C04\uFF0C\u8FD9\u5957\u5730\u5740\u51FA\u4E0D\u4E86\u5185\u7F51\u3002\u586B\u9519\u4E8C\u7EA7\u76EE\u5F55\u540E\u5F53\u524D\u8DEF\u5F84\u4F1A\u5931\u6548\uFF0C\u53EF\u7528\u672C\u673A 127.0.0.1 \u6253\u5F00\u9762\u677F\u6539\u56DE\u3002"
      )
    ),
    // ---------------- 2. 安全认证 ----------------
    h(
      Card,
      { title: "\u5B89\u5168\u8BA4\u8BC1" },
      // 2.1 总开关
      h(
        Row,
        { label: "\u8BBF\u95EE\u8BA4\u8BC1" },
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } },
          h("input", {
            type: "checkbox",
            checked: Boolean(auth.enabled),
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { enabled: e.target.checked })
          }),
          "\u5F00\u542F"
        ),
        auth.enabled ? h("span", { style: S.ok }, "\u5DF2\u5F00\u542F") : h("span", { style: S.warn }, "\u672A\u5F00\u542F \xB7 \u540C\u7F51\u6BB5\u8BBE\u5907\u53EF\u76F4\u63A5\u8FDB\u5165")
      ),
      h(
        "p",
        { style: { ...S.hint, margin: "0 0 12px" } },
        "\u5173\u95ED\u8BBF\u95EE\u8BA4\u8BC1\u4E0D\u4F1A\u5173\u95ED\u7BA1\u7406\u4FDD\u62A4\uFF1A\u5C40\u57DF\u7F51\u8BBF\u5BA2\u53EF\u4EE5\u8FDB\u6765\u770B\uFF0C\u4F46\u4ECD\u7136\u6539\u4E0D\u4E86\u5B89\u5168\u914D\u7F6E\u3002"
      ),
      // 2.2 验证模式
      h(
        Row,
        { label: "\u9A8C\u8BC1\u65B9\u5F0F" },
        h(
          "select",
          {
            style: S.input,
            value: auth.mode || "token_and_password",
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { mode: e.target.value })
          },
          ...Object.entries(MODE_LABELS).map(([k, v]) => h("option", { key: k, value: k }, v))
        )
      ),
      // 2.3 访客密码
      h(
        Row,
        { label: "\u8BBF\u5BA2\u5BC6\u7801" },
        h(
          "span",
          { style: { fontSize: 12, minWidth: 64 } },
          auth.hasPassword ? "\u5DF2\u8BBE\u7F6E" : "\u672A\u8BBE\u7F6E"
        ),
        h("input", {
          style: S.input,
          type: "password",
          placeholder: auth.hasPassword ? "\u8F93\u5165\u65B0\u5BC6\u7801\u4EE5\u66F4\u6362\uFF08\u81F3\u5C11 4 \u4F4D\uFF09" : "\u8BBE\u7F6E\u8BBF\u5BA2\u8BBF\u95EE\u5BC6\u7801\uFF08\u81F3\u5C11 4 \u4F4D\uFF09",
          value: guestPassword,
          onChange: (e) => setGuestPassword(e.target.value)
        }),
        h("button", {
          style: S.btnPrimary,
          disabled: busy || guestPassword.length < 4,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { password: guestPassword });
            if (v) {
              setGuestPassword("");
              setMsg({ kind: "ok", text: "\u8BBF\u5BA2\u5BC6\u7801\u5DF2\u66F4\u65B0\uFF0C\u6240\u6709\u8BBF\u5BA2\u4F1A\u8BDD\u5DF2\u5931\u6548" });
            }
          }
        }, "\u4FDD\u5B58"),
        auth.hasPassword ? h("button", {
          style: S.btnDanger,
          disabled: busy,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { password: "" });
            if (v) setMsg({ kind: "ok", text: "\u5DF2\u6E05\u9664\u8BBF\u5BA2\u5BC6\u7801" });
          }
        }, "\u6E05\u9664") : null
      ),
      // 2.4 管理密码
      h(
        Row,
        { label: "\u7BA1\u7406\u5BC6\u7801" },
        h(
          "span",
          { style: { fontSize: 12, minWidth: 64 } },
          auth.hasAdminPassword ? "\u5DF2\u8BBE\u7F6E" : "\u672A\u8BBE\u7F6E"
        ),
        h("input", {
          style: S.input,
          type: "password",
          placeholder: auth.hasAdminPassword ? "\u8F93\u5165\u65B0\u5BC6\u7801\u4EE5\u66F4\u6362\uFF08\u81F3\u5C11 4 \u4F4D\uFF09" : "\u8BBE\u7F6E\u7BA1\u7406\u5BC6\u7801\uFF08\u53EF\u7559\u7A7A\uFF1A\u6CBF\u7528\u8BBF\u5BA2\u5BC6\u7801\uFF09",
          value: adminPasswordNew,
          onChange: (e) => setAdminPasswordNew(e.target.value)
        }),
        h("button", {
          style: S.btnPrimary,
          disabled: busy || adminPasswordNew.length < 4,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { adminPassword: adminPasswordNew });
            if (v) {
              setAdminPasswordNew("");
              setMsg({ kind: "ok", text: "\u7BA1\u7406\u5BC6\u7801\u5DF2\u66F4\u65B0\uFF0C\u6240\u6709\u7BA1\u7406\u5458\u89E3\u9501\u6001\u5DF2\u91CD\u7F6E" });
            }
          }
        }, "\u4FDD\u5B58"),
        auth.hasAdminPassword ? h("button", {
          style: S.btnDanger,
          disabled: busy,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { adminPassword: "" });
            if (v) setMsg({ kind: "ok", text: "\u5DF2\u6E05\u9664\u7BA1\u7406\u5BC6\u7801\uFF08\u540E\u7EED\u6CBF\u7528\u8BBF\u5BA2\u5BC6\u7801\uFF09" });
          }
        }, "\u6E05\u9664") : null
      ),
      h(
        "p",
        { style: S.hint },
        "\u8BBF\u5BA2\u5BC6\u7801\u7528\u4E8E\u300C\u8FDB\u5165 DSH\u300D\uFF1B\u7BA1\u7406\u5BC6\u7801\u7528\u4E8E\u300C\u4FEE\u6539\u5B89\u5168\u914D\u7F6E\u300D\u548C\u300C\u67E5\u770B\u514D\u5BC6\u4E8C\u7EF4\u7801\u300D\u3002\u672A\u5355\u72EC\u8BBE\u7F6E\u7BA1\u7406\u5BC6\u7801\u65F6\uFF0C\u4E24\u4EF6\u4E8B\u5171\u7528\u8BBF\u5BA2\u5BC6\u7801\u3002"
      ),
      // 2.5 防篡改策略
      h(
        Row,
        { label: "\u9632\u7BE1\u6539" },
        h(
          "select",
          {
            style: S.input,
            value: auth.adminPolicy || "password_unlock",
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { adminPolicy: e.target.value })
          },
          ...Object.entries(POLICY_LABELS).map(([k, v]) => h("option", { key: k, value: k }, v))
        )
      ),
      // 2.6 管理保护开关
      h(
        Row,
        { label: "\u7BA1\u7406\u4FDD\u62A4" },
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } },
          h("input", {
            type: "checkbox",
            checked: auth.adminProtection !== false,
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { adminProtection: e.target.checked })
          }),
          "\u4FEE\u6539\u914D\u7F6E\u9700\u8981\u7BA1\u7406\u6743\u9650"
        ),
        auth.adminProtection === false ? h("span", { style: S.warn }, "\u5DF2\u5173\u95ED \xB7 \u5C40\u57DF\u7F51\u5185\u4EFB\u4F55\u4EBA\u90FD\u80FD\u6539\u914D\u7F6E") : null
      ),
      // 2.7 本机免密
      h(
        Row,
        { label: "\u672C\u673A\u514D\u5BC6" },
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } },
          h("input", {
            type: "checkbox",
            checked: auth.allowLoopback !== false,
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { allowLoopback: e.target.checked })
          }),
          "127.0.0.1 \u76F4\u8FDE\u4E0D\u7528\u5BC6\u7801"
        )
      ),
      // 2.8 令牌
      h(
        Row,
        { label: "\u626B\u7801\u4EE4\u724C" },
        h("span", { style: S.mono }, auth.secretToken || "\u2014"),
        h("button", {
          style: S.btn,
          disabled: busy,
          onClick: async () => {
            const v = await call(EP.authRegenerateToken, {});
            if (v) {
              setQr(null);
              await loadQr(adminToken);
              setMsg({ kind: "ok", text: "\u4EE4\u724C\u5DF2\u91CD\u7F6E\uFF0C\u65E7\u4E8C\u7EF4\u7801\u5168\u90E8\u5931\u6548" });
            }
          }
        }, "\u91CD\u7F6E"),
        adminToken ? h("button", { style: S.btn, onClick: () => void doLock() }, "\u9501\u5B9A\u7BA1\u7406") : null
      ),
      h(
        "p",
        { style: S.hint },
        "\u4EE4\u724C\u5185\u5D4C\u5728\u4E8C\u7EF4\u7801\u91CC\uFF0C\u662F\u672C\u673A\u7B7E\u53D1\u7684 256 \u4F4D\u968F\u673A\u4E32\uFF1B\u91CD\u7F6E\u540E\u6240\u6709\u65E7\u4E8C\u7EF4\u7801\u7ACB\u5373\u5931\u6548\u3002\u300C\u5BC6\u7801 + \u626B\u7801\u300D\u6A21\u5F0F\u4E0B\u5B83\u662F\u514D\u5BC6\u76F4\u901A\u7684\u94A5\u5319\uFF0C\u8BF7\u5F53\u4F5C\u5BC6\u7801\u4FDD\u7BA1\u3002"
      )
    ),
    // 3. 工作区（本机目录浏览 + 注册，手机端不提供）
    h(
      Card,
      { title: "\u5DE5\u4F5C\u533A" },
      !adminToken ? h(
        "p",
        { style: S.hint },
        "\u89E3\u9501\u7BA1\u7406\u5458\u540E\u53EF\u5728\u8FD9\u91CC\u6D4F\u89C8\u8FD9\u53F0\u7535\u8111\u7684\u76EE\u5F55\uFF0C\u628A\u6587\u4EF6\u5939\u4E00\u952E\u6CE8\u518C\u4E3A DSH \u5DE5\u4F5C\u533A\u3002\u672C\u673A\u7528 127.0.0.1 \u6253\u5F00\u9762\u677F\u4F1A\u81EA\u52A8\u89E3\u9501\u3002"
      ) : h(
        "div",
        null,
        h(
          Row,
          { label: "\u5DF2\u6CE8\u518C" },
          wsList === null ? h("span", { style: { fontSize: 12 } }, "\u8BFB\u53D6\u4E2D\u2026") : wsList.length === 0 ? h("span", { style: { fontSize: 12 } }, "\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u533A") : h(
            "div",
            { style: { flex: 1, minWidth: 220 } },
            ...wsList.map((w) => h(
              "div",
              { key: w.id ?? w.path, style: { fontSize: 12, padding: "2px 0" } },
              h("span", { style: { fontWeight: 500 } }, w.title),
              " ",
              h("span", { style: S.hint }, w.path)
            ))
          )
        ),
        browse?.roots?.length ? h(
          Row,
          { label: "\u5FEB\u6377" },
          ...browse.roots.map((r) => h("button", {
            key: r.path,
            style: S.btn,
            onClick: () => void browseTo(r.path)
          }, r.name)),
          ...browse.drives.map((d) => h("button", {
            key: d.path,
            style: S.btn,
            onClick: () => void browseTo(d.path)
          }, d.name))
        ) : null,
        browse ? h(
          Row,
          { label: "\u4F4D\u7F6E" },
          ...browse.breadcrumbs.map((b) => h("button", {
            key: b.path,
            style: { ...S.btn, padding: "4px 8px" },
            onClick: () => void browseTo(b.path)
          }, b.name))
        ) : null,
        browse ? h(
          "div",
          {
            style: {
              maxHeight: 200,
              overflowY: "auto",
              marginBottom: 8,
              border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)",
              borderRadius: 8,
              padding: "6px 10px"
            }
          },
          browse.entries.length === 0 ? h("div", { style: S.hint }, "\uFF08\u6CA1\u6709\u53EF\u663E\u793A\u7684\u5B50\u76EE\u5F55\uFF09") : browse.entries.map((e) => h("div", {
            key: e.path,
            onClick: () => void browseTo(e.path),
            style: { fontSize: 12, padding: "3px 4px", cursor: "pointer", borderRadius: 4 }
          }, "\u{1F4C1} ", e.name))
        ) : null,
        browseErr ? h("div", { style: { ...S.bad, marginBottom: 8 } }, browseErr) : null,
        browse ? h(
          Row,
          { label: "\u5F53\u524D\u76EE\u5F55" },
          h("span", { style: S.mono }, browse.currentPath),
          h("button", {
            style: S.btnPrimary,
            disabled: busy || adding,
            onClick: () => void addToWorkspace(browse.currentPath)
          }, adding ? "\u6DFB\u52A0\u4E2D\u2026" : "\u6DFB\u52A0\u4E3A\u5DE5\u4F5C\u533A")
        ) : null
      ),
      h(
        "p",
        { style: S.hint },
        "\u6DFB\u52A0\u540E\u53EF\u5728\u5DE5\u4F5C\u533A\u4E2D\u65B0\u5EFA\u5BF9\u8BDD\uFF0C\u5BF9\u8BDD\u5C06\u4EE5\u8BE5\u76EE\u5F55\u4E3A\u5DE5\u4F5C\u76EE\u5F55\u3002.ssh / .git \u7B49\u654F\u611F\u76EE\u5F55\u4E0E\u7CFB\u7EDF\u76EE\u5F55\u5DF2\u9ED8\u8BA4\u5C4F\u853D\u3002"
      )
    ),
    // 4. 自检
    h(
      Card,
      { title: "\u81EA\u68C0" },
      h(
        Row,
        { label: "\u68C0\u67E5" },
        h("button", {
          style: S.btn,
          disabled: busy,
          onClick: () => void runDiagnose()
        }, "\u8FD0\u884C\u81EA\u68C0")
      ),
      diag ? h("div", null, ...diag.map((c) => h(
        "div",
        {
          key: c.id,
          style: { display: "flex", gap: 8, fontSize: 12, padding: "4px 0" }
        },
        h("span", { style: { width: 14, textAlign: "center" } }, c.ok ? "\u2713" : c.warnOnly ? "!" : "\u2717"),
        h("span", { style: { minWidth: 92, fontWeight: 500 } }, c.label),
        h("span", { style: c.ok ? S.ok : c.warnOnly ? S.warn : S.bad }, c.detail)
      ))) : h("p", { style: S.hint }, "\u70B9\u300C\u8FD0\u884C\u81EA\u68C0\u300D\u68C0\u67E5\u4E0A\u6E38\u670D\u52A1\u3001\u4EE3\u7406\u7AEF\u53E3\u3001\u7F51\u5361\u3001\u56DE\u73AF\u51ED\u636E\u4E0E\u95E8\u7981\u72B6\u6001\u3002")
    ),
    // 版本页脚：排障第一眼要看的东西（升级后是否真的生效、面板与包是否同版本）
    h(
      "p",
      { style: { ...S.hint, textAlign: "center", marginTop: 4 } },
      `dsh-porthole v${status.version || "(\u672A\u77E5)"}` + (status.basePath ? ` \xB7 \u6302\u5728 ${status.basePath}` : "") + (status.host && status.host !== "0.0.0.0" ? ` \xB7 \u4EC5\u76D1\u542C ${status.host}` : "")
    )
  );
}
function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(BRIDGE_RPC_CHANNEL, endpoint, payload, signal);
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: "dsh-porthole",
      order: 10,
      label: () => "\u8FDC\u7A0B\u8BBF\u95EE"
    },
    (props) => h(BridgePanel, { ...props, rpcCall })
  ));
}

    return module.exports;
  }
});
