import { useEffect, useState } from "react";
import Modal from "~/ui/modal";
import { toast } from "~/ui/hooks/use-toast";

type SchemaSwitchModalProps = {
    open: boolean;
    database: string;
    current: string;
    schemas: { name: string; tables: number }[];
    onClose: () => void;
    onChanged: (schema: string) => void;
};

/**
 * Picks the schema a database is browsed in (app/routes/api.schema.ts)
 */
export const SchemaSwitchModal = ({ open, database, current, schemas, onClose, onChanged }: SchemaSwitchModalProps) => {
    const [selected, setSelected] = useState(current);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) setSelected(current);
    }, [open, current]);

    const submit = async () => {
        if (selected === current) return onClose();
        setSaving(true);
        try {
            const response = await fetch("/api/schema", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ db: database, schema: selected }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || "Could not change the schema");
            onChanged(selected);
            onClose();
        } catch (error: any) {
            toast({ title: "Error", description: error.message, type: "background" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            onPrimaryClick={submit}
            loading={saving}
            loadingDescription="Switching..."
            modalHeading="Switch schema"
            modalLabel={database}
            primaryButtonText="Switch"
            secondaryButtonText="Cancel">
            <p className="mb-3 text-sm text-neutral-500">The sidebar, the tables, the query editor and the AI assistant use this schema for {database}.</p>
            <div role="radiogroup" aria-label="Schema" className="flex flex-col overflow-y-auto border divide-y rounded max-h-80 border-neutral-200 divide-neutral-200">
                {schemas.map((schema) => (
                    <label key={schema.name} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-neutral-50 ${selected === schema.name ? "bg-neutral-50" : ""}`}>
                        <input type="radio" name="schema" value={schema.name} checked={selected === schema.name} onChange={() => setSelected(schema.name)} />
                        <span className="flex-1 font-mono text-[13px] truncate">{schema.name}</span>
                        <span className="text-xs text-neutral-500">
                            {schema.tables} table{schema.tables === 1 ? "" : "s"}
                            {schema.name === current ? " · current" : ""}
                        </span>
                    </label>
                ))}
            </div>
        </Modal>
    );
};
