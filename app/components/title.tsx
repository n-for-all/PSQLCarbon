import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { useState } from "react";

interface TitleWithCopy {
    title?: string;
    children: React.ReactElement | React.ReactElement[];
    allowCopy?: boolean;
}

const copyToClipboard = (text: string): Promise<void> => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve) => {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.top = "0";
        textArea.style.left = "0";
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            document.execCommand("copy");
        } catch (err) {
            console.error("Fallback copy failed", err);
        }
        document.body.removeChild(textArea);
        resolve();
    });
};

export const Title: React.FC<TitleWithCopy> = ({ title, children, allowCopy = true }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!title) {
            return;
        }
        copyToClipboard(title).then(() => {
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1000);
        });
    };

    return (
        <div className="flex items-center">
            <h4 className="text-xl font-medium">{children}</h4>
            {allowCopy && (
                <button onClick={handleCopy} className="ml-2 text-gray-500 hover:text-gray-700">
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            )}
        </div>
    );
};

export default Title;
