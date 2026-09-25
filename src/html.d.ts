// 声明 HTML 模块导入（Cloudflare Workers 原生支持）
declare module '*.html' {
  const content: string;
  export default content;
}
