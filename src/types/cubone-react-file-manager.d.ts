declare module '@cubone/react-file-manager' {
  import * as React from 'react';

  export type FileManagerFile = {
    name: string;
    isDirectory: boolean;
    path: string;
    updatedAt?: string;
    size?: number;
    [key: string]: unknown;
  };

  export type FileManagerPermissions = {
    create?: boolean;
    upload?: boolean;
    move?: boolean;
    copy?: boolean;
    rename?: boolean;
    download?: boolean;
    delete?: boolean;
  };

  export interface FileManagerProps {
    className?: string;
    files: FileManagerFile[];
    initialPath?: string;
    isLoading?: boolean;
    layout?: 'list' | 'grid';
    enableFilePreview?: boolean;
    height?: string | number;
    width?: string | number;
    style?: React.CSSProperties;
    language?: string;
    fontFamily?: string;
    primaryColor?: string;
    permissions?: FileManagerPermissions;
    onFolderChange?: (path: string) => void;
    onSelectionChange?: (files: FileManagerFile[]) => void;
    onCreateFolder?: (name: string, parentFolder: FileManagerFile) => void;
    onRename?: (file: FileManagerFile, newName: string) => void;
    onDelete?: (files: FileManagerFile[]) => void;
    onPaste?: (
      files: FileManagerFile[],
      destinationFolder: FileManagerFile,
      operationType: 'copy' | 'move',
    ) => void;
    onRefresh?: () => void;
    onFileOpen?: (file: FileManagerFile) => void;
    onError?: (error: { type?: string; message?: string }, file?: FileManagerFile) => void;
    formatDate?: (date: string | Date) => string;
  }

  export const FileManager: React.ComponentType<FileManagerProps>;
}
