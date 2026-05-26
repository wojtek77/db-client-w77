import { RecentSqlFiles } from "../recentFiles/RecentSqlFiles";

export async function openRecentFilesCommand() {
    await RecentSqlFiles.getInstance().openRecentFiles();
}
