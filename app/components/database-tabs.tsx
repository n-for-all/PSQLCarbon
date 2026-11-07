import { Link } from "@remix-run/react";
import { DatabaseBackup, Network, Table2 } from "lucide-react";

type DatabaseTab = "tables" | "relations" | "backup";

/**
 * Switches between the pages of one database: its tables, the relations diagram and backup & restore
 */
export const DatabaseTabs = ({ database, active }: { database: string; active: DatabaseTab }) => {
    const db = encodeURIComponent(database);
    const tabs: { key: DatabaseTab; label: string; to: string; icon: React.ReactNode }[] = [
        { key: "tables", label: "Tables", to: `/database/${db}`, icon: <Table2 size={14} /> },
        { key: "relations", label: "Relations", to: `/diagram/${db}`, icon: <Network size={14} /> },
        { key: "backup", label: "Backup & Restore", to: `/backup/${db}`, icon: <DatabaseBackup size={14} /> },
    ];

    return (
        <nav className="flex items-end gap-1 mb-4 overflow-x-auto overflow-y-hidden border-b border-neutral-200" aria-label="Database sections">
            <span className="py-2 pr-3 mr-1 font-mono text-sm font-semibold border-r whitespace-nowrap text-neutral-900 border-neutral-200" title="Database">
                {database}
            </span>
            {tabs.map((tab) => (
                <Link
                    key={tab.key}
                    to={tab.to}
                    aria-current={tab.key === active ? "page" : undefined}
                    className={`flex items-center gap-1.5 px-3 py-2 -mb-px text-sm whitespace-nowrap border-b-2 ${
                        tab.key === active ? "border-primary text-neutral-900 font-medium" : "border-transparent text-neutral-500 hover:text-neutral-900"
                    }`}>
                    {tab.icon}
                    {tab.label}
                </Link>
            ))}
        </nav>
    );
};
