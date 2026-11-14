/** The largest file skillseekr reads into memory: read_skill_file, get_skill/show bodies, and frontmatter parsing. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The largest file the security scan reads. A regular file over this size is reported as unscannable. */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;

/** A file with a NUL byte in its first SNIFF_BYTES is treated as binary. */
export const SNIFF_BYTES = 8192;
