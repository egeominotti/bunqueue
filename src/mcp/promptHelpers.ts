import { boundedPrompt } from './inspectionBounds';

export function errorPrompt(description: string, error: string) {
  return {
    description,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: boundedPrompt(
            `Failed to gather bunqueue data: ${error}\n\nThe server may be unreachable. Check connectivity and try again.`
          ),
        },
      },
    ],
  };
}
