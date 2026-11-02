import type { ReviewCommentEntry } from '../../api/tasks';
import { useBanner } from '../../context';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';
import { sendCommentsToChat } from './sendOpenComments';

interface SendOpenCommentsDialogProps {
  comments: ReviewCommentEntry[];
  agent: string | null;
  onClose: () => void;
}

/** "Send N comments to <agent>?" — mounted only while open. */
export function SendOpenCommentsDialog({ comments, agent, onClose }: SendOpenCommentsDialogProps) {
  const { showBanner } = useBanner();
  const n = comments.length;
  const noun = n === 1 ? 'comment' : 'comments';
  const who = agent || 'the active chat';
  return (
    <ConfirmDialog
      isOpen
      variant="info"
      title={`Send ${n} ${noun} to ${who}?`}
      message={`${who} gets ${n === 1 ? 'the open comment' : `all ${n} open comments`} in one message, with file and line, and is asked to reply to each in Code Review once it's addressed.`}
      confirmLabel={`Send ${n} ${noun}`}
      onCancel={onClose}
      onConfirm={() => {
        sendCommentsToChat(comments);
        showBanner(`${n} ${noun} sent to ${who}`, 'success');
        onClose();
      }}
    />
  );
}
