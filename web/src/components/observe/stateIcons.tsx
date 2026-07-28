// State → lucide icon map for the observability nodes + inspector. Geometric
// icons, not emoji, to keep the enterprise look consistent with the builder.
import type { ComponentType } from "react";
import {
  UserPlus,
  Mail,
  Clock,
  Bell,
  Inbox,
  MessagesSquare,
  Handshake,
  BadgeCheck,
  CreditCard,
  Wallet,
  FileCheck,
  UserCog,
  CheckCircle2,
  XCircle,
  UserX,
  Clock4,
  AlertTriangle,
  Circle,
  type LucideProps,
} from "lucide-react";
import type { InstanceState } from "../../api/types";

type Icon = ComponentType<LucideProps>;

const MAP: Record<InstanceState, Icon> = {
  ENROLLED: UserPlus,
  OUTREACH_SENT: Mail,
  AWAITING_REPLY: Clock,
  FOLLOWED_UP: Bell,
  REPLY_RECEIVED: Inbox,
  NEGOTIATING: MessagesSquare,
  ACCEPTED: Handshake,
  REWARD_PENDING: BadgeCheck,
  REWARD_CONFIRMED: BadgeCheck,
  PAYMENT_PENDING: CreditCard,
  PAYMENT_RECEIVED: Wallet,
  CONTENT_BRIEF_SENT: FileCheck,
  NEEDS_DEAL_FINALIZATION: UserCog,
  HANDOFF_COMPLETE: CheckCircle2,
  AWAITING_BRAND_APPROVAL: BadgeCheck,
  REJECTED: XCircle,
  OPTED_OUT: UserX,
  NO_RESPONSE: Clock4,
  MANUAL_REVIEW: AlertTriangle,
};

export function stateIcon(state: InstanceState): Icon {
  return MAP[state] ?? Circle;
}
