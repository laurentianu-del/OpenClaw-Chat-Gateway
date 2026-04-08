import fs from 'fs';
import path from 'path';

export type MessageAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

export function rewriteMessageWithWorkspaceUploads(
  message: string,
  absoluteUploadsDir: string,
  options: { extractImageAttachments?: boolean } = {}
): { text: string; attachments: MessageAttachment[] } {
  const attachments: MessageAttachment[] = [];
  const extractImageAttachments = options.extractImageAttachments === true;

  const imageExts: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };

  const text = message.replace(/(!?)\[([^\]]*)\]\(\/uploads\/([^)]+)\)/g, (_match, exclaim, altText, filename) => {
    const absolutePath = path.join(absoluteUploadsDir, filename);
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    const mimeType = imageExts[ext];

    if (extractImageAttachments && exclaim === '!' && mimeType) {
      try {
        if (fs.existsSync(absolutePath)) {
          attachments.push({
            type: 'image',
            mimeType,
            content: fs.readFileSync(absolutePath).toString('base64'),
          });
          return '';
        }
      } catch (error) {
        console.error(`[rewriteMessageWithWorkspaceUploads] Failed to read image ${absolutePath}:`, error);
      }
    }

    return `${exclaim}[${altText}](${absolutePath})`;
  });

  return {
    text: text.trim(),
    attachments,
  };
}
