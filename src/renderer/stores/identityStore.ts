import { create } from 'zustand';
import type { Identity } from '../../shared/types';

type IdentityState = Identity & { setIdentity: (i: Identity) => void };

export const useIdentityStore = create<IdentityState>((set) => ({
  userName: 'You',
  agentName: 'KyDog',
  setIdentity: (i) => set({ userName: i.userName, agentName: i.agentName }),
}));
