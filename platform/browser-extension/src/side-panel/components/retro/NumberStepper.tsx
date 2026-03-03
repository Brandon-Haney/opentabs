import type { InputHTMLAttributes } from 'react';
import { useRef } from 'react';
import { cn } from '../../lib/cn';

interface NumberStepperProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
}

/**
 * Neo-brutalist number stepper using a native `<input type="number">`.
 * The browser handles digit-only filtering, ArrowUp/Down stepping, and
 * min/max clamping. Custom chevron buttons trigger stepUp/stepDown on
 * the native input. onChange fires on blur with the committed value.
 */
const NumberStepper = ({
  defaultValue,
  min = 1,
  max = 65535,
  step = 1,
  onChange,
  className,
  ...props
}: NumberStepperProps) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const input = inputRef.current;
    if (!input) return;
    const num = input.valueAsNumber;
    if (Number.isNaN(num)) return;
    const clamped = Math.min(max, Math.max(min, num));
    if (clamped !== num) input.value = String(clamped);
    onChange?.(clamped);
  };

  const stepUp = () => {
    inputRef.current?.stepUp();
    commit();
  };

  const stepDown = () => {
    inputRef.current?.stepDown();
    commit();
  };

  return (
    <div
      className={cn(
        'inline-flex items-stretch rounded border-2 border-border shadow-sm transition focus-within:shadow-xs',
        className,
      )}>
      <input
        ref={inputRef}
        type="number"
        defaultValue={defaultValue}
        min={min}
        max={max}
        step={step}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
        }}
        className="hide-number-spinner w-[6ch] min-w-0 bg-transparent px-1 font-mono text-xs outline-hidden"
        {...props}
      />
      <div className="flex flex-col border-border border-l">
        <button
          type="button"
          tabIndex={-1}
          onClick={stepUp}
          aria-label="Increment"
          className="flex flex-1 cursor-pointer items-center justify-center px-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
            <path
              d="M1 4L4 1L7 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="border-border border-t" />
        <button
          type="button"
          tabIndex={-1}
          onClick={stepDown}
          aria-label="Decrement"
          className="flex flex-1 cursor-pointer items-center justify-center px-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
            <path
              d="M1 1L4 4L7 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

export { NumberStepper };
export type { NumberStepperProps };
