import { useState } from "react";
import { JsonTreeEditor } from "./tree";
import { CopyText } from "./copy_text";
import Modal from "~/ui/modal";
import { Button } from "~/ui/button";

import { SortAscIcon, SortDescIcon, EyeIcon } from "@primer/octicons-react";

interface CsvTableProps {
    sort: { field: string; direction: number };
    rows: any[];
    columns?: string[];
    allowEdit?: boolean;
    onSort: (field: string) => void;
}

export const CsvTable = ({ sort, rows, columns, allowEdit = false, onSort }: CsvTableProps) => {
    let headers: string[] = columns || [];
    if (headers.length === 0 && rows.length > 0) {
        rows.forEach((row) => {
            Object.keys(row).forEach((key: string) => {
                if (!headers.includes(key)) headers.push(key);
            });
        });
    }
    const [activeRecord, setActiveRecord] = useState<any>(null);

    return (
        <div className="w-full max-w-full overflow-auto">
            <Modal
                open={!!activeRecord}
                modalHeading="Record Details"
                onClose={() => setActiveRecord(null)}
                secondaryButtonText="Close"
            >
                {activeRecord && (
                    <div className="max-h-[60vh] overflow-y-auto bg-white p-4 border border-neutral-200">
                        <JsonTreeEditor autocompleteItems={[]} isExpanded={true} data={activeRecord} />
                    </div>
                )}
            </Modal>
            <table border={1} className="bg-neutral-50 w-full min-w-max">
                <thead>
                    <tr>
                        <th className="px-4 py-2 text-left text-md bg-neutral-100 w-10"></th>
                        {headers.map((header, index) => {
                            return (
                                <th
                                    className="px-4 py-2 text-left text-md bg-neutral-100 group w-0"
                                    id={`${header}-${index}`}
                                    key={header}>
                                    <div className="flex items-center justify-between min-w-[150px] resize-x overflow-hidden pr-2">
                                        <div 
                                            className="flex-1 flex items-center justify-between gap-2 cursor-pointer"
                                            onClick={() => {
                                                onSort(header);
                                            }}
                                        >
                                            <span className="truncate">{header}</span>
                                            <span className={sort.field == header ? "opacity-60 group-hover:opacity-100 flex-shrink-0" : "opacity-0 group-hover:opacity-40 flex-shrink-0"}>
                                                {sort.field == header && sort.direction > 0 ? <SortAscIcon /> : <SortDescIcon />}
                                            </span>
                                        </div>
                                    </div>
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, rowIndex) => (
                        <tr key={row.id || row._id || rowIndex} className={"opacity-80 hover:opacity-100 border-b " + (rowIndex % 2 == 0 ? "bg-white" : "")}>
                            <td className="px-2 py-2 text-center align-top">
                                <Button size="sm" variant="ghost" hasIconOnly icon={<EyeIcon />} onClick={() => setActiveRecord(row)} />
                            </td>
                            {headers.map((key) => {
                                if ((Array.isArray(row[key]) || row[key] instanceof Object) && !(row[key] instanceof Date)) {
                                    return (
                                        <td className="px-4 py-2 w-0" key={key}>
                                            <div className="flex items-start gap-2 group/item">
                                                <div className="line-clamp-2 w-full">
                                                    <JsonTreeEditor autocompleteItems={[]} allowEdit={allowEdit} data={row[key]} />
                                                </div>
                                                <CopyText className="p-1 ml-auto opacity-0 group-hover/item:opacity-100 hover:bg-white flex-shrink-0" text={JSON.stringify(row[key], null, 2)} />
                                            </div>
                                        </td>
                                    );
                                }

                                let output = "";

                                if (row[key] instanceof Date) {
                                    output = row[key].toISOString();
                                } else {
                                    output = String(row[key]);
                                }
                                return (
                                    <td className="px-4 py-2 w-0" key={key}>
                                        <div className="flex items-center gap-1 px-1 text-sm group hover:bg-white">
                                            <div className="line-clamp-2 w-full break-all whitespace-pre-wrap" title={output}>{String(row[key])}</div>
                                            <CopyText className="p-1 ml-auto opacity-0 group-hover:opacity-100 hover:bg-neutral-200 flex-shrink-0" text={output} />
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};
