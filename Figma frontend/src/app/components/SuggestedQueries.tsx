import { memo } from 'react';

interface SuggestedQueriesProps {
  onSelect: (query: string) => void;
}

// Curated suggestions - simple and direct
const SUGGESTIONS = [
  'Verstappen vs Norris 2024',
  'Leclerc vs Sainz this season',
  'Hamilton career summary',
  'Who won Monaco 2024?',
  'Fastest at Silverstone 2024',
  'Norris vs Piastri head to head',
];

export const SuggestedQueries = memo(function SuggestedQueries({
  onSelect,
}: SuggestedQueriesProps) {
  return (
    <div>
      <p className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium px-1">
        Try asking
      </p>
      <div className="flex flex-col">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => onSelect(suggestion)}
            className="
              w-full text-left
              px-3 py-3
              -mx-3
              rounded
              hover:bg-neutral-900
              active:bg-neutral-800
              transition-colors duration-100
              text-sm text-neutral-500
              hover:text-neutral-300
            "
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
});
