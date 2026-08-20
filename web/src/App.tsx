import { NavLink, Route, Routes } from "react-router-dom";
import { OrgChartPage } from "./pages/OrgChart";
import { SessionsPage } from "./pages/Sessions";
import { ChatPage } from "./pages/Chat";
import { CachePage } from "./pages/Cache";
import { SchedulesPage } from "./pages/Schedules";
import { SettingsPage } from "./pages/Settings";

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Foreman · Dashboard</span>
        <nav>
          <NavLink to="/" end>组织</NavLink>
          <NavLink to="/chat">对话</NavLink>
          <NavLink to="/sessions">会话</NavLink>
          <NavLink to="/schedules">定时任务</NavLink>
          <NavLink to="/cache">缓存</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
        <span className="spacer" />
        <span className="hint">localhost-only · 改配置即时热加载</span>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<OrgChartPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/cache" element={<CachePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
