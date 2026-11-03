// lib/constants.js —— 跨模块共享的标识常量
//
// 为什么单独一个文件：插件名同时是 npm 包名、DSH loader id、cordis 条目名、
// RPC 通道名与数据目录名，散落在各处极易改漏。登录会话目录（auth/manager.js）
// 与主入口（index.js）都要用到它，而两者互相 import 会成环，故下沉到这里。

/** 插件名 / 包名后缀 / loader id / 数据目录名（四者必须一致） */
export const PLUGIN_NAME = 'dsh-porthole';

/** RPC 通道名（客户端与宿主共用，必须与 PLUGIN_NAME 派生一致） */
export const RPC_CHANNEL = '/dsh-porthole';
