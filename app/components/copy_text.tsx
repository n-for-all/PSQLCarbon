import { Button } from "@ui/button";
import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { useState } from "react";

interface TitleWithCopy {
    text?: string;
    className?: string;
    iconClassName?: string;
}

interface ButtonWithCopy {
    text?: string;
    [x: string]: any;
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

export const CopyText: React.FC<TitleWithCopy> = ({ text, className, iconClassName }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!text) {
            return;
        }
        copyToClipboard(String(text)).then(() => {
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1000);
        });
    };

    return (
        <span className={"cursor-pointer" + (className ? " " + className : "")} onClick={handleCopy}>
            {copied ? <CheckIcon className={iconClassName} /> : <CopyIcon className={iconClassName} />}
        </span>
    );
};
export const CopyTextButton: React.FC<ButtonWithCopy> = ({ text, children, ...rest }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!text) {
            return;
        }
        copyToClipboard(String(text)).then(() => {
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1000);
        });
    };

    return (
        <Button icon={copied ? <CheckIcon /> : <CopyIcon />} onClick={handleCopy} {...rest}>
            {children}
        </Button>
    );
};
