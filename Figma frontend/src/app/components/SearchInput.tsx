import { useRef, FormEvent, useCallback, forwardRef, useImperativeHandle } from 'react';

interface SearchInputProps {
  onFocus?: () => void;
  onSubmit: (query: string) => void;
  isLoading?: boolean;
  compact?: boolean;
}

export interface SearchInputRef {
  focus: () => void;
  setValue: (value: string) => void;
}

export const SearchInput = forwardRef<SearchInputRef, SearchInputProps>(function SearchInput(
  { onFocus, onSubmit, isLoading = false, compact = false },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Expose focus and setValue methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
    },
    setValue: (value: string) => {
      if (inputRef.current) {
        inputRef.current.value = value;
      }
    },
  }));

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const value = inputRef.current?.value.trim();
      if (value) {
        onSubmit(value);
      }
    },
    [onSubmit]
  );

  return (
    <form onSubmit={handleSubmit}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          name="search"
          placeholder="ask anything about f1"
          onFocus={onFocus}
          disabled={isLoading}
          autoComplete="off"
          className={`
            w-full bg-black text-white
            border border-neutral-800
            outline-none
            transition-colors duration-100
            placeholder:text-neutral-600
            focus:border-neutral-600
            disabled:opacity-50 disabled:cursor-not-allowed
            ${compact ? 'px-4 py-3 text-base' : 'px-5 py-4 text-lg'}
          `}
          style={{
            fontWeight: 400,
            letterSpacing: '-0.01em',
          }}
        />
        {isLoading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-neutral-700 border-t-white rounded-full animate-spin" />
          </div>
        )}
      </div>
    </form>
  );
});
