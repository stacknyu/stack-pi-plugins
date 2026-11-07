import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, ms = 150) => { await sleep(ms); return fetch(path).then((r) => r.json()).catch(() => ({})); };

function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); addEventListener("popstate", f); return () => removeEventListener("popstate", f); }, []);
  const go = (p) => { history.pushState({}, "", p); setPath(p); };
  return [path, go];
}

// BUG 3: header re-fetches credits on every route change and shows "…" meanwhile (text flap)
function Header({ path }) {
  const [credits, setCredits] = useState(120);
  useEffect(() => { setCredits(null); api("/api/credits.json", 120).then(() => setCredits(120)); }, [path]);
  return <header style={{ background: "#1e3a8a", color: "#fff", padding: 14, height: 24 }}>Platform · Credits: <b id="credits">{credits ?? "…"}</b></header>;
}

// BUG 1: each page renders its own Sidebar -> unmount+mount on every navigation, and it fetches the user on mount (skeleton flash)
function Sidebar({ go }) {
  const [user, setUser] = useState(null);
  useEffect(() => { api("/api/me.json", 180).then(() => setUser({ name: "Arjun" })); }, []);
  const item = (p, label) => <a href={p} onClick={(e) => { e.preventDefault(); go(p); }} style={{ display: "block", padding: "8px 0", color: "#111" }}>{label}</a>;
  return (
    <nav aria-label="Main" style={{ position: "absolute", left: 0, top: 52, width: 180, bottom: 0, background: "#f1f5f9", padding: 10 }}>
      {user ? <div style={{ fontWeight: 700 }}>{user.name}</div> : <div style={{ height: 18, width: 90, background: "#cbd5e1" }} />}
      {item("/dashboard", "Dashboard")}{item("/chat", "Chat")}{item("/notes", "Notes")}{item("/research", "Research")}
    </nav>
  );
}

function Main({ children }) { return <main style={{ marginLeft: 210, padding: 16 }}>{children}</main>; }

function DashboardPage({ go }) {
  return <><Sidebar go={go} /><Main><h1>Dashboard</h1><div className="card" style={{ background: "#fde68a", padding: 20 }}>Market overview: NIFTY 24,310</div></Main></>;
}
function NotesPage({ go }) {
  return <><Sidebar go={go} /><Main><h1>Notes</h1><p>Germany checklist</p></Main></>;
}
function ResearchPage({ go }) {
  return <><Sidebar go={go} /><Main><h1>Research</h1><p>No reports yet</p></Main></>;
}

// BUG 2: ChatBox is defined inside ChatPage (new component type every render) + a 1.5s poll re-renders ChatPage,
// and messages are reset to [] before refetch -> list flashes empty and the input box remounts
function ChatPage({ go }) {
  const [messages, setMessages] = useState(["Hi! How can I help with admissions?"]);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1500); return () => clearInterval(t); }, []);
  useEffect(() => { if (!tick) return; setMessages([]); api("/api/messages.json", 90).then(() => setMessages(["Hi! How can I help with admissions?"])); }, [tick]);
  function ChatBox() { return <div className="chatbox" style={{ border: "1px solid #999", padding: 8, marginTop: 8 }}><input aria-label="Message" placeholder="Ask anything" style={{ width: 300 }} /><button>Send</button></div>; }
  return <><Sidebar go={go} /><Main><h1>Chat</h1><div style={{ minHeight: 40, background: "#eef2ff", padding: 8 }}>{messages.map((m, i) => <div key={i}>{m}</div>)}</div><ChatBox /></Main></>;
}

function App() {
  const [path, go] = useRoute();
  const Page = { "/chat": ChatPage, "/notes": NotesPage, "/research": ResearchPage }[path] || DashboardPage;
  return <><Header path={path} /><Page go={go} /></>;
}
createRoot(document.getElementById("root")).render(<App />);
