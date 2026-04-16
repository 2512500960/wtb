import fs from 'fs';
import path from 'path';

export const ensureDirAsync = async (dirPath: string): Promise<void> => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

export const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const ensureDirExists = (dirPath: string): void => {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    if (!fs.existsSync(dirPath)) throw error;
  }
};

export const isUnderDir = (childPath: string, parentPath: string): boolean => {
  const child = path.resolve(childPath).toLowerCase();
  const parent = path.resolve(parentPath).toLowerCase();
  return child === parent || child.startsWith(parent + path.sep);
};
