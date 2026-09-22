/**
 * **One icon per meaning, and one meaning per icon** (owner, 2026-09-20).
 *
 * Ninety-five different lucide icons were in use across the modules with no list anywhere, so the
 * same thing was drawn two ways and the same drawing meant two things: close a window and remove a
 * row were both `X` (and, in eight places, the typographic character `×`); a person was `User`,
 * `Users`, `UsersRound` or `UserRound` depending on the file; expand was a chevron here and an
 * arrow there.
 *
 * This is the vocabulary. **Import the meaning, not the picture**: `IconEdit`, never `Pencil`. When
 * a new meaning appears, it is added here, once, and everybody gets the same drawing; when a
 * drawing has to change, it changes here and every screen follows.
 *
 * `/ui` renders this whole file, so what the CRM has is a page you can look at rather than a
 * grep. Icons inside `Button` and `IconButton` are sized BY the button — call sites pass no size.
 *
 * Nothing here is a decision about colour: red belongs to `IconButton danger`, never to the icon.
 */
export {
  // ── what a thing is ────────────────────────────────────────────────────────
  ListTodo as IconTask,
  UserRound as IconClient,
  Sparkles as IconLead,
  Receipt as IconInvoice,
  CalendarDays as IconMeeting,
  FileText as IconFile,
  Folder as IconFolder,
  KeyRound as IconSecret,
  MessageSquare as IconChat,
  Mail as IconLetter,
  Megaphone as IconCampaign,
  Layers as IconService,
  FileSignature as IconTemplate,
  Users as IconTeam,
  Building2 as IconCompany,
  Bell as IconNotification,
  // ── what can be done ──────────────────────────────────────────────────────
  Pencil as IconEdit,
  Plus as IconAdd,
  Trash2 as IconDelete,
  Check as IconConfirm,
  X as IconClose,
  Copy as IconCopy,
  Link2 as IconLink,
  Download as IconDownload,
  Upload as IconUpload,
  /** put this into a folder in Files: a task's file filed, a chat's file kept */
  FolderInput as IconFileInto,
  Paperclip as IconAttach,
  Search as IconSearch,
  SlidersHorizontal as IconFilter,
  MoreHorizontal as IconMenu,
  Eye as IconShow,
  EyeOff as IconHide,
  Pin as IconPin,
  Archive as IconArchive,
  RotateCcw as IconRestore,
  Power as IconToggle,
  Send as IconSend,
  CornerUpLeft as IconReply,
  CornerUpRight as IconForward,
  // ── where to go ───────────────────────────────────────────────────────────
  ChevronRight as IconExpand,
  ChevronDown as IconCollapse,
  ChevronUp as IconUp,
  ChevronLeft as IconBack,
  ExternalLink as IconOpen,
  /** back to where a thing came from: the message a file was sent in, the row a hit is on */
  ArrowRightToLine as IconGoTo,
  // ── how a thing is ────────────────────────────────────────────────────────
  Lock as IconLocked,
  AlertTriangle as IconWarning,
  CircleSlash as IconUnavailable,
  Clock as IconWaiting,
  GripVertical as IconDrag,
} from "lucide-react";

/**
 * **Three sizes, and no others.** A control sizes the icon it holds, so these are for an icon that
 * stands on its own — beside a heading, in an empty state, inside a chip.
 *
 * `row` is 15px because that is what the design system has said since 2026-07-30 for a table row;
 * `inline` is 14 for dense text; `large` is 18 for a heading or an empty state.
 */
export const ICON_SIZE = { inline: 14, row: 15, large: 18 } as const;
