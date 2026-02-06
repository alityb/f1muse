import { memo } from 'react';
import { motion } from 'motion/react';

interface ErrorDisplayProps {
  message: string;
  question: string | null;
  suggestions?: string[];
  onSuggestionClick?: (suggestion: string) => void;
}

// Map error types to user-friendly messages
function getErrorContext(message: string): { title: string; hint: string } {
  const lower = message.toLowerCase();

  if (lower.includes('driver') && lower.includes('not found')) {
    return {
      title: "Driver not recognized",
      hint: "Check the spelling or try using the driver's full name (e.g., \"Verstappen\" or \"Max Verstappen\")"
    };
  }

  if (lower.includes('track') && lower.includes('not found')) {
    return {
      title: "Track not found",
      hint: "Try using the official circuit name (e.g., \"Monaco\", \"Silverstone\", \"Monza\")"
    };
  }

  if (lower.includes('season') || lower.includes('year')) {
    return {
      title: "Season data unavailable",
      hint: "Data is available for recent seasons. Try specifying a year between 2018-2025"
    };
  }

  if (lower.includes('insufficient') || lower.includes('no data')) {
    return {
      title: "Not enough data",
      hint: "The drivers may not have raced together, or the data isn't available for this combination"
    };
  }

  if (lower.includes('timeout') || lower.includes('unavailable')) {
    return {
      title: "Service temporarily busy",
      hint: "The system is processing many requests. Try again in a moment"
    };
  }

  if (lower.includes('ambiguous') || lower.includes('unclear')) {
    return {
      title: "Question needs clarification",
      hint: "Try being more specific about what you want to compare"
    };
  }

  return {
    title: "Couldn't process request",
    hint: message
  };
}

export const ErrorDisplay = memo(function ErrorDisplay({
  message,
  question,
  suggestions = [],
  onSuggestionClick,
}: ErrorDisplayProps) {
  const { title, hint } = getErrorContext(message);

  // Generate suggestions if none provided
  const displaySuggestions = suggestions.length > 0 ? suggestions : getDefaultSuggestions(question);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="py-6"
    >
      {/* Original question */}
      {question && (
        <p className="text-sm text-neutral-500 mb-5 leading-tight">
          {question}
        </p>
      )}

      {/* Error message - clean, not alarming */}
      <div className="mb-6">
        <p className="text-lg text-white font-medium mb-2">{title}</p>
        <p className="text-sm text-neutral-400 leading-relaxed">{hint}</p>
      </div>

      {/* Clickable suggestions */}
      {displaySuggestions.length > 0 && (
        <div className="pt-4 border-t border-neutral-800">
          <p className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
            Try these instead
          </p>
          <div className="flex flex-col gap-2">
            {displaySuggestions.slice(0, 3).map((suggestion, i) => (
              <button
                key={i}
                onClick={() => onSuggestionClick?.(suggestion)}
                className="
                  text-left text-sm text-neutral-300
                  py-2 px-3 rounded
                  bg-neutral-900/50 hover:bg-neutral-800
                  transition-colors duration-100
                  active:bg-neutral-700
                "
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
});

/**
 * Generate default suggestions based on the failed query
 */
function getDefaultSuggestions(question: string | null): string[] {
  if (!question) {
    return [
      "Verstappen vs Hamilton 2024",
      "Who won Monaco 2024?",
      "Norris vs Piastri this season"
    ];
  }

  const lower = question.toLowerCase();
  const suggestions: string[] = [];

  // If asking about drivers, suggest popular comparisons
  if (lower.includes('vs') || lower.includes('versus') || lower.includes('compare')) {
    suggestions.push("Verstappen vs Norris 2024");
    suggestions.push("Leclerc vs Sainz this season");
    suggestions.push("Hamilton career summary");
  }
  // If asking about a track/race
  else if (lower.includes('race') || lower.includes('gp') || lower.includes('grand prix')) {
    suggestions.push("Who won Monaco 2024?");
    suggestions.push("Fastest at Silverstone 2024");
    suggestions.push("Race results Monza 2024");
  }
  // If asking about stats
  else if (lower.includes('pole') || lower.includes('qualifying') || lower.includes('q3')) {
    suggestions.push("Verstappen poles 2024");
    suggestions.push("Q3 rankings 2024");
    suggestions.push("Qualifying gap Norris vs Piastri");
  }
  // Default suggestions
  else {
    suggestions.push("Verstappen vs Hamilton 2024");
    suggestions.push("Who won Monaco 2024?");
    suggestions.push("Norris season summary 2024");
  }

  return suggestions;
}
