#!/usr/bin/env python3
import argparse
def main():
  ap=argparse.ArgumentParser(); ap.add_argument("cmd",choices=["scan-rooms","tile-pdfs","extract-indices","compute-transforms","validate"]); ap.parse_args()
  print("Optional helpers; UI shows placeholders until assets exist.")
if __name__=="__main__": main()