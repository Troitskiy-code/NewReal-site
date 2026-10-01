export type GuestMessageCopy = {
  characterId: string;
  chatId: string;
  userId: string;
  role: string;
  content: string;
  createdAt: Date;
};

export function mapGuestMessagesToUserMessages(
  messages: Array<{ characterId: string; role: string; content: string; createdAt: Date }>,
  userId: string
): GuestMessageCopy[] {
  return messages.map((message) => ({
    characterId: message.characterId,
    chatId: message.characterId,
    userId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }));
}
