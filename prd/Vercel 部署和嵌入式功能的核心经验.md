# Vercel 部署 + 外部网页嵌入式功能 经验总结

## 一、项目背景

基于 uni-app + Vue3 的 H5 项目，需要部署到 Vercel，并将"统计分析"和"智能问答"两个菜单从新窗口打开改为页面内嵌入式效果（保留顶部导航和左侧菜单）。

---

## 二、Vercel 部署踩坑记录

### 2.1 失败方案汇总（10+ 次失败）

#### 方案 1：`@vercel/static` + `dist/build/h5/` 路径
```json
{
  "builds": [
    { "src": "dist/build/h5/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/(.*)", "dest": "/dist/build/h5/index.html" }
  ]
}
```
**失败原因：** 静态文件路径映射错误，`/assets/*.js` 返回 404。

#### 方案 2：Express 提供静态文件
```javascript
// api/index.js
app.use(express.static(path.join(__dirname, '../dist/build/h5')))
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/build/h5/index.html'))
})
```
**失败原因：** 出现 `exports is not defined` 错误，模块加载异常。

#### 方案 3：`public` 目录 + `filesystem` handler
```json
{
  "routes": [
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
```
**失败原因：** 构建命令执行失败，`public` 目录未生成。

#### 方案 4：静态文件放根目录，不配置 `@vercel/static`
```json
{
  "builds": [{ "src": "api/index.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/api/(.*)", "dest": "/api/index.js" }]
}
```
**失败原因：** Vercel 不会自动托管根目录的静态文件，根路径返回 404。

### 2.2 最终成功方案

#### 核心配置（vercel.json）
```json
{
  "version": 2,
  "builds": [
    { "src": "api/index.js", "use": "@vercel/node" },
    { "src": "index.html", "use": "@vercel/static" },
    { "src": "assets/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/index.js" },
    { "src": "/assets/(.*)", "dest": "/assets/$1" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
```

#### 关键要点
1. **静态文件放项目根目录**：`index.html` 和 `assets/` 直接放在根目录，不要放 `dist/build/h5/` 等深层目录
2. **明确声明 `@vercel/static`**：必须在 `builds` 中明确指定哪些文件由 `@vercel/static` 构建
3. **路由顺序很重要**：API → 静态资源 → SPA 回退，顺序不能乱
4. **不要用 Express 提供静态文件**：会导致模块加载问题（`exports is not defined`）
5. **构建产物提交到 git**：Vercel 不执行前端构建时，直接使用 git 中的静态文件

---

## 三、外部网页嵌入式功能实现

### 3.1 需求说明
- 原效果：点击"统计分析"/"智能问答"菜单 → `window.open` 新窗口打开外部链接
- 新效果：点击菜单 → 在当前页面内嵌入外部网页 → 保留顶部导航栏和左侧菜单栏

### 3.2 实现步骤

#### 步骤 1：创建嵌入式页面

**文件：** `src/pages/statistics/index.vue`

```vue
<template>
  <view class="main-layout">
    <TopNav />
    
    <view class="layout-body">
      <SideMenu />
      
      <view class="main-content">
        <view class="statistics-container">
          <iframe 
            class="statistics-iframe"
            src="https://外部网址链接"
            frameborder="0"
            allowfullscreen
          ></iframe>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import TopNav from '@/components/TopNav.vue'
import SideMenu from '@/components/SideMenu.vue'
</script>

<style lang="scss" scoped>
.main-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.layout-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.main-content {
  flex: 1;
  background: #F5F7FA;
  overflow-y: auto;
}

.statistics-container {
  height: calc(100vh - 60px);
  background: #FFFFFF;
  margin: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.statistics-iframe {
  width: 100%;
  height: 100%;
  border: none;
}
</style>
```

**关键点：**
- 页面包含完整布局：TopNav + SideMenu + 内容区
- 内容区用 `<iframe>` 嵌入外部网页
- 高度设为 `calc(100vh - 60px)`，减去顶部导航高度

#### 步骤 2：注册页面路由

**文件：** `src/pages.json`

```json
{
  "pages": [
    {
      "path": "pages/statistics/index",
      "style": {
        "navigationStyle": "custom",
        "navigationBarTitleText": "统计分析"
      }
    },
    {
      "path": "pages/qa/index",
      "style": {
        "navigationStyle": "custom",
        "navigationBarTitleText": "智能问答"
      }
    }
  ]
}
```

**关键点：**
- `navigationStyle: "custom"` 使用自定义导航栏

#### 步骤 3：修改菜单点击事件

**文件：** `src/components/SideMenu.vue`

```javascript
// ❌ 修改前：新窗口打开
if (sub.id === 'statistical-analysis') {
  window.open('https://外部网址链接')
}

// ✅ 修改后：页面内跳转（嵌入式）
if (sub.id === 'statistical-analysis') {
  uni.navigateTo({ url: '/pages/statistics/index' })
} else if (sub.id === 'intelligent-qa') {
  uni.navigateTo({ url: '/pages/qa/index' })
}
```

---

## 四、完整文件清单

| 文件路径 | 作用 | 备注 |
|---------|------|------|
| `vercel.json` | Vercel 部署配置 | 核心配置 |
| `api/index.js` | API 入口文件 | 引用 `server/src/index.js` 中的 app |
| `index.html` | 前端入口页面 | 放根目录 |
| `assets/` | 静态资源（JS/CSS） | 放根目录 |
| `src/pages/statistics/index.vue` | 统计分析嵌入式页面 | iframe + 完整布局 |
| `src/pages/qa/index.vue` | 智能问答嵌入式页面 | iframe + 完整布局 |
| `src/components/TopNav.vue` | 顶部导航栏组件 | 公共组件 |
| `src/components/SideMenu.vue` | 左侧菜单组件 | 点击跳转逻辑 |
| `src/pages.json` | 路由配置 | 注册新页面 |

---

## 五、常见问题排查

| 问题 | 可能原因 | 排查/解决方案 |
|------|---------|--------------|
| 页面 404 | 静态文件路径配置错误 | 检查 `vercel.json` 的 `builds` 和 `routes` 配置，确保静态文件路径正确 |
| `exports is not defined` | 通过 Node.js 提供静态文件 | 改用 `@vercel/static` 直接托管静态文件 |
| 点击菜单没反应 | 路由未注册 | 检查 `pages.json` 中是否注册了对应页面，路径是否一致 |
| iframe 显示空白 | 外部网站禁止嵌入 | 检查外部网站是否设置了 `X-Frame-Options` 或 CSP 策略 |
| 菜单高亮不对 | 菜单状态未更新 | 在点击事件中设置 `currentSubMenu` / `currentMenu` |
| Vercel 部署失败 | 构建命令错误 | 简化配置，直接使用 git 中的构建产物 |
| API 请求 404 | 路由配置错误 | 确保 `/api/*` 路由在最前面，指向 `api/index.js` |

---

## 六、经验总结

### 6.1 Vercel 部署经验

1. **越简单越可靠**：静态文件放根目录 + 明确配置 `@vercel/static`，这是最不容易出错的方案
2. **路径越浅越好**：不要把静态文件放深层目录，路径映射容易出错
3. **路由顺序不能乱**：API 最优先，然后是静态资源，最后是 SPA 回退
4. **静态文件和 API 分开**：不要用 Express 提供静态文件，用 Vercel 原生的静态托管
5. **先让页面跑起来**：不要一开始就搞自动构建，先用已有的构建产物验证部署

### 6.2 嵌入式功能经验

1. **保留完整布局**：嵌入式页面必须包含 TopNav 和 SideMenu，保持用户体验一致
2. **用 iframe 最简单**：直接用 `<iframe>` 嵌入外部页面，不需要复杂的微前端方案
3. **高度计算要准确**：`calc(100vh - 60px)` 减去顶部导航高度，确保 iframe 占满剩余空间
4. **导航用 uni.navigateTo**：不要用 `window.open`，这样才是页面内跳转
5. **记得注册路由**：新增页面必须在 `pages.json` 中注册，否则跳转失败

---

## 七、后续优化建议

1. **构建自动化**：目前是手动构建后提交到 git，可以考虑配置 CI/CD 自动构建
2. **iframe 通信**：如果需要主页面和 iframe 交互，可以用 `postMessage`
3. **加载状态**：可以给 iframe 添加加载动画，提升用户体验
4. **错误处理**：iframe 加载失败时显示友好的错误提示
