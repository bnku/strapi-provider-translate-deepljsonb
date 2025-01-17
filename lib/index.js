"use strict";

const deepl = require("deepl-node");
const Bottleneck = require("bottleneck/es5");

const {
  DEEPL_PRIORITY_DEFAULT,
  DEEPL_API_MAX_TEXTS,
  DEEPL_API_ROUGH_MAX_REQUEST_SIZE,
  DEEPL_APP_INFO,
} = require("./constants");
const { parseLocale } = require("./parse-locale");
const { getService } = require("./get-service");

/**
 * Module dependencies
 */

module.exports = {
  provider: "deepl",
  name: "DeepL",

  init(providerOptions = {}) {
    const apiKey = process.env.DEEPL_API_KEY || providerOptions.apiKey;
    const apiUrl = process.env.DEEPL_API_URL || providerOptions.apiUrl;
    const localeMap =
      typeof providerOptions.localeMap === "object"
        ? providerOptions.localeMap
        : {};
    const apiOptions =
      typeof providerOptions.apiOptions === "object"
        ? providerOptions.apiOptions
        : {};

    const client = new deepl.Translator(apiKey, {
      serverUrl: apiUrl,
      appInfo: DEEPL_APP_INFO,
    });

    const limiter = new Bottleneck({
      minTime: process.env.NODE_ENV == "test" ? 10 : 200,
      maxConcurrent: 5,
    });

    const rateLimitedTranslate = limiter.wrap(
      client.translateText.bind(client)
    );
    const isBlocks = (value) => {
      if (Array.isArray(value) && Array.isArray(value[0])) {
        let founds = value[0].filter((elem) => {
          return elem["type"] != undefined && elem["type"] == "paragraph";
        });
        if (founds.length > 0) {
          return true;
        }
      }
      return false;
    };

    const translateBlock = async (block, sourceLocale, targetLocale, tagHandling) =>{
      const chunksService = getService("chunks");
      console.log(block);
      if (["list-item", "list", "link"].includes(block.type)  && block.children) {
        for (let child of block.children) {
          await translateBlock(child, sourceLocale, targetLocale, tagHandling)
        }
      }
      if (block.type === "text" && block.text != "" && !block?.code) {
        console.log(block.text);
        let { chunks, reduceFunction } = chunksService.split(
          [block.text],
          {
            maxLength: DEEPL_API_MAX_TEXTS,
            maxByteSize: DEEPL_API_ROUGH_MAX_REQUEST_SIZE,
          }
        );

        let resultTranslated = reduceFunction(
          await Promise.all(
            chunks.map(async (texts) => {
              const result = await rateLimitedTranslate.withOptions(
                {
                  priority:
                    typeof priority == "number"
                      ? priority
                      : DEEPL_PRIORITY_DEFAULT,
                },
                texts,
                parseLocale(sourceLocale, localeMap, "source"),
                parseLocale(targetLocale, localeMap, "target"),
                { ...apiOptions, tagHandling }
              );
              return result.map((value) => value.text);
            })
          )
        );
        block.text = resultTranslated.join("");    
      }
    }

    return {
      /**
       * @param {{
       *  text:string|string[],
       *  sourceLocale: string,
       *  targetLocale: string,
       *  priority: number,
       *  format?: 'plain'|'markdown'|'html'
       * }} options all translate options
       * @returns {string[]} the input text(s) translated
       */
      async translate({ text, priority, sourceLocale, targetLocale, format }) {
        if (!text) {
          return [];
        }
        if (!sourceLocale || !targetLocale) {
          throw new Error("source and target locale must be defined");
        }
        let result = [];
        const chunksService = getService("chunks");
        const tagHandling = format === "plain" ? undefined : "html";

        if (!isBlocks(text)) {
         
          const formatService = getService("format");

          
          let textArray = Array.isArray(text) ? text : [text];

          if (format === "markdown") {
            textArray = formatService.markdownToHtml(textArray);
          }

          const { chunks, reduceFunction } = chunksService.split(textArray, {
            maxLength: DEEPL_API_MAX_TEXTS,
            maxByteSize: DEEPL_API_ROUGH_MAX_REQUEST_SIZE,
          });

          result = reduceFunction(
            await Promise.all(
              chunks.map(async (texts) => {
                const result = await rateLimitedTranslate.withOptions(
                  {
                    priority:
                      typeof priority == "number"
                        ? priority
                        : DEEPL_PRIORITY_DEFAULT,
                  },
                  texts,
                  parseLocale(sourceLocale, localeMap, "source"),
                  parseLocale(targetLocale, localeMap, "target"),
                  { ...apiOptions, tagHandling }
                );
                return result.map((value) => value.text);
              })
            )
          );

          if (format === "markdown") {
            return formatService.htmlToMarkdown(result);
          }
        } else {
          //BEGIN

          let out = [];
          for (let elems of text) {
            let paragraphs = [];
            for (let elem of elems) {
              if (["paragraph", "heading", "list"].includes(elem.type)) {
                for (let child of elem.children) {
                  await translateBlock(child, sourceLocale, targetLocale, tagHandling)
                }
              }
              paragraphs.push(elem);
            }
            out.push(paragraphs);
          }
          
         result = out;
         //END
        }
        return result;
      },
      async usage() {
        return (await client.getUsage()).character;
      },
    };
  },
};
