'use client';

import { ClipboardIcon, CheckIcon } from 'lucide-react';
import { useState } from 'react';

interface CommandDisplayProps {
  command: string;
}

export const CommandDisplay = ({ command }: CommandDisplayProps) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (err: unknown) => {
        console.error('Failed to copy text: ', err);
      },
    );
  };

  const syntaxColors = ['text-primary', 'text-accent-foreground', 'text-muted-foreground', 'text-foreground'];

  // Split the command into parts for syntax highlighting
  const parts = command.split(' ').map((part, index) => {
    const color = syntaxColors[index % syntaxColors.length];
    return (
      <span key={index} className={color}>
        {part}
      </span>
    );
  });

  return (
    <div className="group bg-secondary text-secondary-foreground relative flex items-center py-2 pl-4 font-mono text-xs">
      <div className="flex-1 overflow-hidden whitespace-nowrap">
        <div className="overflow-hidden text-ellipsis">
          {parts.map((part, index) => (
            <span key={`part-${index}`}>
              {part}
              {index < parts.length - 1 && ' '}
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={copyToClipboard}
        className="text-muted-foreground hover:text-foreground mr-2 shrink-0 p-1 transition-colors"
        aria-label="Copy command">
        {copied ? <CheckIcon className="text-primary h-4 w-4" /> : <ClipboardIcon className="h-4 w-4" />}
      </button>
    </div>
  );
};
