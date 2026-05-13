# Wojak Draft Assistant

这是一个用于 X 平台自动三连和发帖排队的本地工具，包含两部分：

- `local-task-server`：本地前端页面 + 简单任务服务
- `wojak-draft-extension`：Chrome 扩展，负责监听队列、打开 X、点赞、转发、评论、发原创贴，并把结果回传给本地服务

项目当前没有构建步骤，也不依赖数据库。启动本地服务后，任务和执行结果都保存在内存里，重启服务后会清空。

## 功能概览

- 本地页面提交 X 帖子链接，加入任务队列
- 多队列管理：新增、重命名、删除、启停、测试模式
- 一个链接可以一次加入所有已启动队列
- 当前队列可以直接生成“原创贴”任务
- Chrome 扩展按窗口监听，每个窗口可以绑定一个队列
- 自动执行点赞、转发、评论、附图
- 评论完成后回传评论链接或原创贴链接
- 无任务时自动浏览首页，并带有随机点赞行为
- 三连任务默认带 2 到 10 分钟随机间隔，测试模式可跳过
- 任务支持进度心跳和超时恢复，卡死后会自动释放队列

## 目录结构

```text
.
├── README.md
├── comments.json                 # 评论文案池
├── Original.json                 # 原创贴文案池
├── image/                        # 本地服务可读取的原创贴配图
├── local-task-server/
│   └── server.js                 # 本地前端页面和任务 API
└── wojak-draft-extension/
    ├── manifest.json
    ├── background.js             # 监听、调度、状态回传
    ├── content.js                # X 页面内自动操作
    ├── popup.html
    ├── popup.js
    └── assets/                   # 评论任务默认配图
```

## 运行环境

- macOS
- Google Chrome
- Node.js 18+
- 已登录 X 的 Chrome 用户环境

## 快速开始

### 1. 启动本地服务

```bash
cd "/Users/qzai/Desktop/wojak 冲推/local-task-server"
node server.js
```

默认监听地址：

```text
http://127.0.0.1:8787
```

如果要改端口，可以用环境变量：

```bash
PORT=9000 node server.js
```

### 2. 打开前端页面

浏览器访问：

```text
http://127.0.0.1:8787
```

页面支持以下操作：

- 输入一个 X 帖子链接，加入所有已启动队列
- 在队列 Tab 之间切换查看不同队列
- 启动或关闭当前队列
- 开启或关闭测试模式
- 新增、重命名、删除队列
- 清空当前队列任务和结果
- 为当前队列创建原创贴任务

任务表格当前会显示：

- 目标链接
- 已评论链接
- 状态
- 创建时间
- 评论时间
- 操作

### 3. 安装 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：

```text
/Users/qzai/Desktop/wojak 冲推/wojak-draft-extension
```

如果修改了扩展代码，需要在扩展页点击“重新加载”。

### 4. 在扩展里开始监听

点击扩展图标，在弹窗中：

1. 填写前端服务地址，默认 `http://127.0.0.1:8787`
2. 选择当前 Chrome 窗口要监听的队列
3. 点击“开始监听”

监听开启后：

- 当前窗口会绑定一个队列
- 没有新任务时，会在 X 首页滚动浏览，并随机点赞
- 有新任务时，会从绑定队列里取任务执行
- 一个队列同一时刻只会执行一个任务

## 队列模型

### 同一队列是串行的

同一个队列中，同时出现：

- 第一个任务 `running`
- 后面的任务 `pending`

这是正常行为，不是 bug。当前实现是“每个队列一次只跑一个任务”。

### 想并行处理，要用多队列 + 多窗口

如果你要同时跑多个链接任务，正确方式是：

1. 在前端新增多个队列
2. 打开多个 Chrome 窗口
3. 每个窗口在扩展里绑定不同队列并开始监听

这样不同队列之间可以并行，不同队列内仍然保持串行。

### 测试模式

当前队列开启测试模式后：

- 目标任务之间的随机等待会被跳过
- 更适合联调和流程验证
- 首页浏览和随机点赞逻辑仍然保留

## 自动执行流程

### 链接评论任务

扩展取到普通链接任务后，会依次执行：

1. 打开目标帖子
2. 点赞
3. 转发
4. 读取评论文案
5. 附加图片
6. 发布评论
7. 回传评论链接

评论文案来源：

- 服务端未指定时，从根目录 `comments.json` 随机取一条

评论图片来源：

- 服务端指定了 `imageAssetPath` 时，优先用服务端图片
- 未指定时，扩展会从 `wojak-draft-extension/assets/` 随机取图

### 原创贴任务

点击页面里的“发原创贴”后，会向当前队列加入一个原创贴任务。扩展执行时会：

1. 打开 `https://x.com/home`
2. 从 `Original.json` 读取一条原创文案
3. 从根目录 `image/` 随机取一张图
4. 发布原创贴
5. 回传原创贴链接

## 任务状态

前后端现在会同步任务过程中的中间状态，常见状态包括：

- `pending`
- `running`
- `opening`
- `watching`
- `refreshing`
- `liking`
- `reposting`
- `composing`
- `uploading_image`
- `waiting_image`
- `publishing`
- `replied`
- `spam_reply`
- `error`

其中：

- `replied` 表示成功完成并已回传结果
- `spam_reply` 表示评论可能被 X 折叠为垃圾贴
- `error` 表示任务失败

## 超时与恢复

为了避免任务卡死后队列永远不动，当前实现增加了两层恢复：

- 服务端：任务长时间没有收到进度心跳，会回退成 `pending`，重新排队
- 扩展端：本地任务长时间无活动，或执行标签页被关闭，会标记为 `error` 并释放队列

默认超时窗口是 10 分钟。

## 常用接口

### 队列

获取队列列表：

```bash
curl http://127.0.0.1:8787/api/wojak/queues
```

新增队列：

```bash
curl -X POST http://127.0.0.1:8787/api/wojak/queues \
  -H 'Content-Type: application/json' \
  -d '{"name":"队列 2"}'
```

修改队列名称或状态：

```bash
curl -X PATCH http://127.0.0.1:8787/api/wojak/queues/default \
  -H 'Content-Type: application/json' \
  -d '{"name":"默认队列","enabled":true,"testMode":false}'
```

### 任务

向所有已启动队列加入一个链接任务：

```bash
curl -X POST http://127.0.0.1:8787/api/wojak/tasks \
  -H 'Content-Type: application/json' \
  -d '{"targetUrl":"https://x.com/i/status/1234567890","allQueues":true}'
```

只向单个队列加入任务：

```bash
curl -X POST http://127.0.0.1:8787/api/wojak/tasks \
  -H 'Content-Type: application/json' \
  -d '{"targetUrl":"https://x.com/i/status/1234567890","queueId":"default"}'
```

查看某个队列的任务和结果：

```bash
curl "http://127.0.0.1:8787/api/wojak/tasks?queueId=default"
```

为当前队列创建原创贴任务：

```bash
curl -X POST http://127.0.0.1:8787/api/wojak/original-tasks \
  -H 'Content-Type: application/json' \
  -d '{"queueId":"default"}'
```

删除一条前台记录：

```bash
curl -X DELETE http://127.0.0.1:8787/api/wojak/tasks/<taskId>
```

清空某个队列的任务和结果：

```bash
curl -X DELETE "http://127.0.0.1:8787/api/wojak/tasks?queueId=default"
```

## 常见问题

### 1. 为什么我加了多个链接，只有一个在 running？

因为同一队列是串行执行。后面的任务处于 `pending` 是正常的。

如果你要并行，请使用多个队列，并让不同 Chrome 窗口分别监听不同队列。

### 2. 页面显示 running 很久，最后报超时怎么办？

现在系统会自动恢复：

- 服务端会把长时间无心跳的任务重新排队
- 扩展端会把卡死任务标成失败并释放队列

如果你刚改过代码，先做一次：

1. 重启 `local-task-server/server.js`
2. 在 `chrome://extensions/` 里重新加载扩展

### 3. 为什么服务重启后任务没了？

因为当前任务和结果保存在内存里，没有持久化存储。

### 4. 为什么扩展没反应？

重点检查：

- Chrome 是否已登录 X
- 本地服务是否在运行
- 扩展里的服务地址是否正确
- 当前窗口是否已经点击“开始监听”
- 当前窗口绑定的队列是否已启动

## 开发说明

- 本地服务入口：`local-task-server/server.js`
- 扩展后台逻辑：`wojak-draft-extension/background.js`
- 页面自动操作逻辑：`wojak-draft-extension/content.js`
- 扩展弹窗逻辑：`wojak-draft-extension/popup.js`

如果你修改了：

- 本地服务代码：重启 `node server.js`
- 扩展代码：到 `chrome://extensions/` 重新加载扩展
