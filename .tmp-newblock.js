      /* ---------- 教程变量（域名 / 密钥 / 间隔）：一处修改，全篇示例同步 ---------- */
      function tutorialVars() {
        const domainRaw = (($("tut-domain") && $("tut-domain").value) || "").trim().replace(/\/+$/, "");
        const domain = domainRaw || window.location.origin;
        const secret = (($("tut-secret") && $("tut-secret").value) || "").trim();
        const minutesRaw = parseInt((($("tut-interval") && $("tut-interval").value) || ""), 10);
        const minutes = minutesRaw >= 1 && minutesRaw <= 1440 ? minutesRaw : 5;
        const step = minutes < 5 ? minutes : 5; // cron 表达式步进（GitHub Actions 最小 5 分钟）
        return {
          domain: domain,
          secret: secret,
          minutes: minutes,
          step: step,
          url: function (src) { return domain + "/__cron?source=" + src; },
          secretText: secret || "<你的 CRON_SECRET>",
        };
      }

      function selfhostLink(type) {
        const v = tutorialVars();
        const p = new URLSearchParams({
          type: type,
          url: v.url("selfhost"),
          secret: v.secret,
          interval: String(Math.max(30, v.minutes * 60)),
        });
        return location.origin + "/api/v1/system/selfhost/driver?" + p.toString();
      }

      function renderSelfhostLinks() {
        const box = $("sh-links");
        if (!box) return;
        const d = selfhostLink("driver");
        const i = selfhostLink("install");
        const cmd = 'curl -o cdt-driver.mjs "' + d + '" && curl -o install.sh "' + i + '" && sudo bash install.sh';
        box.innerHTML =
          '<pre><code>' + cmd.replace(/</g, "&lt;") + '</code></pre>' +
          '<div class="row-actions">' +
          '<button class="btn ghost" type="button" id="copy-sh-cmd">复制一键命令</button>' +
          '<button class="btn ghost" type="button" id="copy-sh-driver">复制 driver 下载链接</button>' +
          '<button class="btn ghost" type="button" id="copy-sh-install">复制 install 下载链接</button>' +
          '</div>';
        $("copy-sh-cmd").onclick = function () { copyText(cmd, "一键命令已复制"); };
        $("copy-sh-driver").onclick = function () { copyText(d, "driver 下载链接已复制"); };
        $("copy-sh-install").onclick = function () { copyText(i, "install 下载链接已复制"); };
      }

      // 根据教程变量渲染所有渠道示例（URL / cron 表达式 / 云函数代码 / 下载链接）
      function renderTutorial() {
        const v = tutorialVars();
        function set(id, text) { const el = $(id); if (el) el.textContent = text; }

        set("gh-url", v.url("github"));
        set("cj-url", v.url("http"));
        set("cj-header", "X-Cron-Secret: " + v.secretText);
        set("cj-period", "Every " + v.minutes + " minutes");
        set("scf-url", v.url("selfhost"));
        set("scf-cron", "0 */" + v.step + " * * * *");
        set("fc-url", v.url("selfhost"));
        set("fc-cron", "0 */" + v.step + " * * *");

        set("scf-code",
          "// 腾讯云 SCF：入口 main_handler，环境变量 CDT_URL / CDT_SECRET\n" +
          "const https = require('https');\n\n" +
          "exports.main_handler = async () => {\n" +
          "  const url = process.env.CDT_URL || '" + v.url("selfhost") + "';\n" +
          "  const secret = process.env.CDT_SECRET || '';\n" +
          "  return new Promise((resolve) => {\n" +
          "    const req = https.get(url, { headers: { 'X-Cron-Secret': secret }, timeout: 60000 }, (res) => {\n" +
          "      let body = '';\n" +
          "      res.on('data', (c) => { body += c; });\n" +
          "      res.on('end', () => resolve({ statusCode: res.statusCode, body: body.slice(0, 200) }));\n" +
          "    });\n" +
          "    req.on('error', (e) => resolve({ error: String(e) }));\n" +
          "    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });\n" +
          "  });\n" +
          "};");

        set("fc-code",
          "// 阿里云 FC 3.0：入口 handler，环境变量 CDT_URL / CDT_SECRET\n" +
          "exports.handler = async (event, context) => {\n" +
          "  const url = process.env.CDT_URL || '" + v.url("selfhost") + "';\n" +
          "  const secret = process.env.CDT_SECRET || '';\n" +
          "  try {\n" +
          "    const resp = await fetch(url, {\n" +
          "      method: 'GET',\n" +
          "      headers: { 'X-Cron-Secret': secret },\n" +
          "      signal: AbortSignal.timeout(60000),\n" +
          "    });\n" +
          "    const text = await resp.text();\n" +
          "    return { statusCode: resp.status, body: text.slice(0, 200) };\n" +
          "  } catch (err) {\n" +
          "    return { statusCode: 500, body: String(err) };\n" +
          "  }\n" +
          "};");

        if ($("copy-scf-code")) $("copy-scf-code").onclick = function () { copyText($("scf-code").textContent, "腾讯云 SCF 代码已复制"); };
        if ($("copy-fc-code")) $("copy-fc-code").onclick = function () { copyText($("fc-code").textContent, "阿里云 FC 代码已复制"); };
        renderSelfhostLinks();
      }

      // 初始化教程变量默认值（域名默认当前站点，间隔跟随「监控间隔」）
      function initTutorialVars() {
        const d = $("tut-domain");
        if (d && !d.value) d.value = window.location.origin;
        const iv = $("tut-interval");
        const monitor = parseInt((($("set-monitor") && $("set-monitor").value) || ""), 10);
        if (iv && monitor >= 1) iv.value = String(monitor);
        renderTutorial();
      }

      ["tut-domain", "tut-secret", "tut-interval"].forEach(function (id) {
        const el = $(id);
        if (el) el.addEventListener("input", renderTutorial);
      });
