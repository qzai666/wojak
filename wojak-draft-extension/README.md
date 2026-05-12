# Wojak Draft Assistant

这是一个 Chrome 扩展：监听前端服务平台提交的 X 链接，按 2 分钟间隔执行点赞、转发、评论附图，并把已评论链接回传到平台。监听开启后，如果当前没有新链接，扩展会打开 X 首页并随机点赞一条内容。

## 安装

1. 打开 Chrome。
2. 进入 `chrome://extensions/`。
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择这个目录：

```text
/Users/qzai/Desktop/wojak 冲推/wojak-draft-extension
```

## 使用

1. 启动前端服务平台：

```bash
cd "/Users/qzai/Desktop/wojak 冲推/local-task-server"
node server.js
```

2. 打开平台页面：

```text
http://127.0.0.1:8787
```

3. 在扩展弹窗里填写服务地址 `http://127.0.0.1:8787`，点击“开始监听”。
4. 平台没有新链接时，扩展会保持监听并每 2 分钟回首页随机点赞。
5. 平台只需要提交目标链接；服务会从根目录 `comments.json` 随机取一条评论文案。
6. 扩展会按 2 分钟间隔打开目标链接，自动点赞、转发、评论附图。
7. 评论完成后，扩展会把你自己评论生成的帖子链接回传并展示在平台任务列表里。

也可以直接用命令推送任务：

```bash
curl -X POST http://127.0.0.1:8787/api/wojak/tasks \
  -H 'Content-Type: application/json' \
  -d '{"targetUrl":"https://x.com/i/status/2053953866631160005"}'
```

查看任务和结果：

```bash
curl http://127.0.0.1:8787/api/wojak/tasks
```
