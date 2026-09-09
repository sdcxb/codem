# 设计参考来源：lobster-pet

- **项目**：Lobster Pet — OpenClaw Desktop Pet + Agent Dashboard
- **仓库**：https://github.com/jiaweisibot/lobster-pet
- **作者**：jiaweisibot
- **代码许可**：MIT（见同目录 `LICENSE.txt`）

## 本项目借鉴的内容

**只借鉴信息架构与交互母题，不复制其代码**：

- `DetailPanel` 的「标题栏 + 卡片网格 + 场景嵌入」布局
- `StatusCard` / `TaskGrid` / `ActivityViz`（14 天热力图 + 会话类型环形图 +
  24 小时活跃柱状图）/ `TokenBar` / 实时事件流
- `MiniOffice` 把场景作为监控界面内一个卡片的做法

## 关于其美术资源

lobster-pet 的 `public/office/*` 像素资源与 **Star-Office-UI** 同源
（其 LICENSE 第 25–33 行已注明为非商业用途），因此本项目的美术资源统一从
Star-Office-UI 收录（见 `../star-office/`），此处不重复收录。
