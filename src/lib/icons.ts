/**
 * The app's icon set: HugeIcons' free stroke-rounded glyphs, re-exported
 * under the names the interface already used. Icons are plain data here —
 * components/Icon.svelte renders them — so only the glyphs actually named
 * below reach the bundle.
 */
import {
	Alert02Icon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	ArrowUpRightIcon,
	AudioLinesIcon,
	GoBackward10SecIcon,
	GoForward10SecIcon,
	BookOpen02Icon,
	BookOpenTextIcon,
	BrainCircuitIcon,
	BubbleChatIcon,
	BugIcon,
	Cancel01Icon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ClipboardCopyIcon,
	Clock03Icon,
	CloudIcon,
	CloudRainIcon,
	CoffeeIcon,
	CollapseIcon,
	ContrastIcon,
	CopyIcon,
	CpuIcon,
	DatabaseIcon,
	Delete02Icon,
	DownloadIcon,
	EyeIcon,
	EyeOffIcon,
	File01Icon,
	FileCodeIcon,
	FileImageIcon,
	FileSearchIcon,
	FileTypeIcon,
	FileUpIcon,
	FlowchartIcon,
	FlowerIcon,
	FocusPointIcon,
	FullScreenIcon,
	GaugeIcon,
	GlobeIcon,
	GraduationCapIcon,
	HelpCircleIcon,
	HighlighterIcon,
	ImageIcon,
	Key01Icon,
	KeyboardIcon,
	LeftToRightListBulletIcon,
	LibraryIcon,
	LinkIcon,
	ListTreeIcon,
	Loading03Icon,
	LockKeyIcon,
	Maximize02Icon,
	MenuIcon,
	Mic02Icon,
	MicIcon,
	MicOffIcon,
	Minimize02Icon,
	Moon02Icon,
	MoonIcon,
	PaintBoardIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	PauseIcon,
	PencilEdit02Icon,
	PhoneOffIcon,
	PineTreeIcon,
	Plant01Icon,
	PlayIcon,
	PlusSignIcon,
	RefreshIcon,
	RotateLeft01Icon,
	RotateRight01Icon,
	SearchIcon,
	Settings02Icon,
	ShapesIcon,
	ShieldIcon,
	SparklesIcon,
	SquareIcon,
	StickyNoteIcon,
	SunIcon,
	VolumeHighIcon,
	VolumeLowIcon,
	VolumeMuteIcon,
	WaveIcon,
	WifiIcon
} from '@hugeicons/core-free-icons';

/** A glyph as HugeIcons ships it: `[tag, attributes]` pairs. */
export type IconData = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

export const AlertTriangle = Alert02Icon;
export const ArrowLeft = ArrowLeftIcon;
export const ArrowRight = ArrowRightIcon;
export const ArrowUp = ArrowUpIcon;
export const ArrowUpRight = ArrowUpRightIcon;
export const AudioLines = AudioLinesIcon;
/** The app mark: an open book, used in the header, the loading screen,
 * and the favicon/PWA icons in static/. */
export const BookOpen = BookOpen02Icon;
export const BookOpenText = BookOpenTextIcon;
export const BrainCircuit = BrainCircuitIcon;
export const Bug = BugIcon;
export const Check = CheckIcon;
export const ChevronLeft = ChevronLeftIcon;
export const ChevronRight = ChevronRightIcon;
export const CircleHelp = HelpCircleIcon;
export const ClipboardCopy = ClipboardCopyIcon;
export const Clock3 = Clock03Icon;
export const Cloud = CloudIcon;
export const CloudRain = CloudRainIcon;
export const Coffee = CoffeeIcon;
export const Contrast = ContrastIcon;
export const Copy = CopyIcon;
export const Cpu = CpuIcon;
export const Database = DatabaseIcon;
export const Download = DownloadIcon;
export const Eye = EyeIcon;
export const EyeOff = EyeOffIcon;
export const FileCode = FileCodeIcon;
export const FileImage = FileImageIcon;
export const FileSearch = FileSearchIcon;
export const FileText = File01Icon;
export const FileType = FileTypeIcon;
export const FileUp = FileUpIcon;
export const Flower2 = FlowerIcon;
export const Fullscreen = FullScreenIcon;
export const Gauge = GaugeIcon;
export const Globe = GlobeIcon;
export const GraduationCap = GraduationCapIcon;
export const Highlighter = HighlighterIcon;
export const Image = ImageIcon;
export const KeyRound = Key01Icon;
export const Keyboard = KeyboardIcon;
export const Library = LibraryIcon;
export const Link2 = LinkIcon;
export const List = LeftToRightListBulletIcon;
export const ListTree = ListTreeIcon;
export const LoaderCircle = Loading03Icon;
export const LocateFixed = FocusPointIcon;
export const LockKeyhole = LockKeyIcon;
export const Maximize2 = Maximize02Icon;
export const Menu = MenuIcon;
export const MessagesSquare = BubbleChatIcon;
export const Mic = MicIcon;
export const Mic2 = Mic02Icon;
export const MicOff = MicOffIcon;
export const Minimize2 = Minimize02Icon;
export const Moon = MoonIcon;
export const MoonStar = Moon02Icon;
export const Palette = PaintBoardIcon;
export const PanelLeftClose = PanelLeftCloseIcon;
export const PanelLeftOpen = PanelLeftOpenIcon;
export const Pause = PauseIcon;
export const PencilLine = PencilEdit02Icon;
export const PhoneOff = PhoneOffIcon;
export const Play = PlayIcon;
export const Plus = PlusSignIcon;
export const RefreshCw = RefreshIcon;
export const RotateCcw = RotateLeft01Icon;
export const RotateCw = RotateRight01Icon;
export const Search = SearchIcon;
/** The player's ±10s seeks — HugeIcons draws the number into the glyph. */
export const SkipBack10 = GoBackward10SecIcon;
export const SkipForward10 = GoForward10SecIcon;
export const Settings2 = Settings02Icon;
export const Shapes = ShapesIcon;
export const ShieldCheck = ShieldIcon;
export const Shrink = CollapseIcon;
export const Sparkles = SparklesIcon;
export const Sprout = Plant01Icon;
export const Square = SquareIcon;
export const StickyNote = StickyNoteIcon;
export const Sun = SunIcon;
export const Trash2 = Delete02Icon;
export const TreePine = PineTreeIcon;
export const TriangleAlert = Alert02Icon;
export const Volume1 = VolumeLowIcon;
export const Volume2 = VolumeHighIcon;
export const VolumeX = VolumeMuteIcon;
export const Waves = WaveIcon;
export const Wifi = WifiIcon;
export const Workflow = FlowchartIcon;
export const X = Cancel01Icon;
