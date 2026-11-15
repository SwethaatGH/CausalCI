import { NavLink, useSearchParams } from "react-router-dom";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useUI } from "../../lib/store";
import { cn } from "../../lib/utils";
import { NAV } from "./nav";

export function Sidebar() {
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const toggle = useUI((s) => s.toggleSidebar);
  const [params] = useSearchParams();
  const inv = params.get("inv") ?? useUI.getState().lastInvestigationId;
  const qs = (path: string) => {
    const next = new URLSearchParams();
    if (inv) next.set("inv", inv);
    for (const k of ["commit", "a", "b"]) if (params.get(k)) next.set(k, params.get(k)!);
    const s = next.toString();
    return s ? `${path}?${s}` : path;
  };

  return (
    <aside className={cn("no-print hidden shrink-0 flex-col border-r border-line bg-lab md:flex", collapsed ? "w-[64px]" : "w-[228px]")} aria-label="Primary">
      <div className={cn("flex h-14 items-center", collapsed ? "justify-center" : "px-5")}>
        <span className="font-display text-[17px] font-semibold tracking-[-0.02em] text-ink">{collapsed ? "C" : "CausalCI"}</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((sec) => (
          <div key={sec.section} className="mb-5">
            {!collapsed && <div className="mb-1 px-2.5 text-[12px] font-medium text-ink-3">{sec.section}</div>}
            <ul className="space-y-0.5">
              {sec.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={qs(item.path)}
                    title={collapsed ? `${item.label} — ${item.tech}` : item.tech}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[14px] transition-colors",
                        collapsed && "justify-center px-0",
                        isActive ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:bg-panel-2 hover:text-ink",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-ink" : "text-ink-3 group-hover:text-ink")} strokeWidth={isActive ? 2.2 : 1.8} />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <button onClick={toggle} className="flex h-10 items-center justify-center gap-2 border-t border-line text-xs text-ink-3 hover:text-ink" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : (<><ChevronsLeft className="h-4 w-4" /> Collapse</>)}
      </button>
    </aside>
  );
}
