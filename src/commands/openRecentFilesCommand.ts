import { RecentSqlFiles } from "../recentFiles/RecentSqlFiles.js";

export async function openRecentFilesCommand() {
    await RecentSqlFiles.getInstance().openRecentFiles();
}
