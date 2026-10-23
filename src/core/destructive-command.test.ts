import { describe, expect, test } from "vitest";
import { detectDestructiveCommand } from "./destructive-command";

describe("detectDestructiveCommand", () => {
  test.each([
    "rm -rf /",
    "rm -fr /",
    "rm -r -f /",
    "rm -Rf /*",
    "rm --recursive --force /",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    'rm -rf "${HOME}"',
    "sudo rm -rf /",
    "cd /tmp && rm -rf /",
    "rm$IFS-rf$IFS/",
    '"rm" "-rf" "/"',
    "rm --no-preserve-root -rf /",
    "/bin/rm -rf /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "git push --force origin main",
    "git push -f origin main",
    "git push -uf origin main",
    "git push origin +main",
    "git push --force-with-lease",
    "git -C repo push -f",
  ])("bloque %s", (cmd) => {
    expect(detectDestructiveCommand(cmd).blocked).toBe(true);
  });

  test.each([
    "rm -rf node_modules",
    "rm -rf ./dist /tmp/build",
    "rm file.txt",
    "rm -rf ~/projects/app/dist",
    "git push origin main",
    "git push -u origin feature",
    "dd if=disk.img of=backup.img",
    "echo mkfs is a command",
    "ls -la /",
  ])("autorise %s", (cmd) => {
    expect(detectDestructiveCommand(cmd).blocked).toBe(false);
  });
});
